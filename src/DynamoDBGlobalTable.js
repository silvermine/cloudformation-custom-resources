'use strict';

const _ = require('underscore'),
      util = require('util'),
      BaseResource = require('./BaseResource');

const {
   DynamoDBClient,
   CreateGlobalTableCommand,
   UpdateGlobalTableCommand,
   DescribeGlobalTableCommand,
   CreateTableCommand,
   UpdateTableCommand,
   DescribeTableCommand,
   DeleteTableCommand,
   ListTagsOfResourceCommand,
   TagResourceCommand,
   GlobalTableNotFoundException,
   ResourceNotFoundException,
} = require('@aws-sdk/client-dynamodb');

const AWS_REGION = process.env.AWS_REGION,
      dynamo = new DynamoDBClient({});

const clientCache = { [AWS_REGION]: dynamo };

function clientFor(region) {
   if (!clientCache[region]) {
      clientCache[region] = new DynamoDBClient({ region });
   }
   return clientCache[region];
}

function delay(ms) {
   return new Promise((resolve) => {
      setTimeout(resolve, ms);
   });
}

class DynamoDBGlobalTable extends BaseResource {

   normalizeResourceProperties(props, allowErrors) {
      if (props.DeleteUnneededTables && props.DeleteUnneededTables === 'true') {
         props.DeleteUnneededTables = true;
      } else {
         props.DeleteUnneededTables = false;
      }

      if (props.DeploymentRegions) {
         props.ReplicationGroup = _.map(props.DeploymentRegions, (dr) => {
            return { RegionName: dr.region };
         });
      }

      if (allowErrors && !props.LastStackUpdate) {
         throw new Error('You must supply the LastStackUpdate property for global table resources. See docs.');
      }

      return props;
   }

   // In doCreate and doUpdate we delay ten seconds before starting any operations that
   // will describe tables because while tables are being created or updated, our describe
   // table operation may either (a) not return the table, or (b) return an old
   // description of the table. Note that we are assuming (b) based on the documentation
   // that clearly states (a) for DescribeTable after CreateTable [1]. It only seems
   // logical that describing the table immediately after it was updated would yield the
   // same problem because of the eventually consistent query. Thus, this is a safety
   // measure to try to avoid getting tables out of sync between regions. While that might
   // seem like it would only need to happen in doUpdate, because doCreate is creating the
   // global table, we actually don't know in doCreate if the DynamoDB table was also just
   // created, or if it has existed for some time and now our global table is being
   // created; thus, the actual DynamoDB table could have just been updated. For example,
   // perhaps it was created earlier, and just now an index or stream specification is
   // being added to it, at the same time our global table was added to the stack.
   //
   // [1] https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB.html#describeTable-property
   //
   // Says: Note: If you issue a DescribeTable request immediately after a CreateTable
   // request, DynamoDB might return a ResourceNotFoundException. This is because
   // DescribeTable uses an eventually consistent query, and the metadata for your table
   // might not be available at that moment. Wait for a few seconds, and then try the
   // DescribeTable request again.

   async doCreate(props) {
      const tableName = props.GlobalTableName,
            allRegions = _.pluck(props.ReplicationGroup, 'RegionName'),
            copyTableRegions = _.chain(props.ReplicationGroup).pluck('RegionName').without(AWS_REGION).value();

      console.log('Pausing ten seconds before starting create for global table %s in regions %s', tableName, allRegions);
      await delay(10000);
      await this._printDescriptionsOfTables(tableName, [ AWS_REGION ]);
      await this._ensureTableCopiedToRegions(tableName, copyTableRegions);
      await this._printDescriptionsOfTables(tableName, allRegions);

      return this._ensureGlobalTableConsistent(props);
   }

   async doUpdate(resourceID, props, oldProps) {
      const tableName = props.GlobalTableName,
            allRegions = _.pluck(props.ReplicationGroup, 'RegionName'),
            oldRegions = _.pluck(oldProps.ReplicationGroup, 'RegionName'),
            copyTableRegions = _.without(allRegions, AWS_REGION),
            oldCopyTableRegions = _.without(oldRegions, AWS_REGION);

      console.log('Pausing ten seconds before starting update for global table %s in regions %s', tableName, allRegions);
      await delay(10000);
      await this._printDescriptionsOfTables(tableName, [ AWS_REGION ]);
      await this._ensureTableCopiedToRegions(tableName, copyTableRegions);
      await this._printDescriptionsOfTables(tableName, _.uniq(allRegions.concat(oldRegions)));

      const globalTableCloudFormationResp = await this._ensureGlobalTableConsistent(props),
            regionsToDelete = _.difference(oldCopyTableRegions, copyTableRegions);

      if (props.DeleteUnneededTables) {
         await this._removeTableFromRegions(tableName, regionsToDelete);
         return globalTableCloudFormationResp;
      }

      console.log('Not deleting table %s from regions %s because DeleteUnneededTables was not truthy', tableName, regionsToDelete);
      return globalTableCloudFormationResp;
   }

   async doDelete(resourceID, props) {
      const tableName = props.GlobalTableName,
            copyTableRegions = _.chain(props.ReplicationGroup).pluck('RegionName').without(AWS_REGION).value();

      if (props.DeleteUnneededTables) {
         await this._removeTableFromRegions(tableName, copyTableRegions);
         return { PhysicalResourceId: props.GlobalTableName };
      }

      console.log('Not deleting replica %s tables in %s because DeleteUnneededTables was not truthy', tableName, copyTableRegions);
      return { PhysicalResourceId: props.GlobalTableName };
   }

   async _ensureTableCopiedToRegions(tableName, regions) {
      // Wait for the table to be in any state but DELETING:
      const masterDesc = await this._describeTableUntilState(tableName, AWS_REGION, [ 'CREATING', 'ACTIVE', 'UPDATING' ]);

      if (!this._hasRequiredStreamSpec(masterDesc)) {
         throw new Error('The master table ' + tableName + ' does not have the required NEW_AND_OLD_IMAGES stream enabled');
      }

      const tags = await this._listTags(AWS_REGION, masterDesc.TableArn);

      return Promise.all(_.map(regions, (region) => {
         return this._ensureTableCopiedToRegion(tableName, masterDesc, tags, region);
      }));
   }

   async _ensureTableCopiedToRegion(tableName, masterDesc, masterTags, region) {
      const dyn = clientFor(region),
            copyDesc = await this._describeTable(tableName, region);

      let createOrUpdateResp;

      if (copyDesc) {
         const params = this._makeUpdateTableParams(tableName, region, masterDesc, copyDesc);

         if (params) {
            console.log('Updating a copy of DynamoDB table %s in %s: %j', tableName, region, params);
            createOrUpdateResp = await dyn.send(new UpdateTableCommand(params));
         } else {
            createOrUpdateResp = { TableDescription: copyDesc };
         }
      } else {
         const params = this._makeCreateTableParamsFromDescription(masterDesc);

         console.log('Creating a copy of DynamoDB table %s in %s: %j', tableName, region, params);
         createOrUpdateResp = await dyn.send(new CreateTableCommand(params));
      }

      const arn = createOrUpdateResp.TableDescription.TableArn,
            copyTags = await this._listTags(region, arn);

      if (_.isEqual(masterTags, copyTags)) {
         console.log('No change needed for tags on %s in %s: %j', tableName, region, copyTags);
         return;
      }

      console.log('Tagging table %s in %s with tags %j', tableName, region, masterTags);
      await dyn.send(new TagResourceCommand({ ResourceArn: arn, Tags: masterTags }));
   }

   async _listTags(region, arn) {
      const dyn = clientFor(region);

      let attempts = 0,
          timeout = 2000;

      // We allow 15 attempts here (as opposed to 10 when waiting on tables in certain
      // states) because it seems to take longer for the list-tags-of-resource operation
      // to start showing a new table.
      while (attempts < 15) {
         attempts = attempts + 1;

         let tagsResp;

         try {
            tagsResp = await dyn.send(new ListTagsOfResourceCommand({ ResourceArn: arn }));
         } catch(err) {
            if (err instanceof ResourceNotFoundException) {
               console.log('Could not list tags for %s because of ResourceNotFoundException', arn);
               tagsResp = null;
            } else {
               throw err;
            }
         }

         if (tagsResp) {
            if (tagsResp.NextToken) {
               throw new Error('Too many tags on table ' + arn + ' for this simplistic tag replication');
            }

            return tagsResp.Tags;
         }

         console.log('Will try listing tags for %s again in %s seconds', arn, (timeout / 1000));
         await delay(timeout);
         timeout = Math.min(10000, timeout * 1.5);
      }

      throw new Error(util.format('ERROR: Exhausted all %d attempts waiting for %s to have tags', attempts, arn));
   }

   async _removeTableFromRegions(tableName, regions) {
      if (_.contains(regions, AWS_REGION)) {
         throw new Error('Should not delete table %s from master region %s', tableName, AWS_REGION);
      }

      return Promise.all(_.map(regions, async (region) => {
         const dyn = clientFor(region),
               desc = await this._describeTable(tableName, region);

         if (desc) {
            console.log('Deleting table %s in region %s', tableName, region);
            await dyn.send(new DeleteTableCommand({ TableName: tableName }));
            console.log('Done deleting table %s in region %s', tableName, region);
         }
      }));
   }

   async _describeTable(tableName, region) {
      const dyn = clientFor(region);

      try {
         const resp = await dyn.send(new DescribeTableCommand({ TableName: tableName }));

         return resp.Table;
      } catch(err) {
         if (err instanceof ResourceNotFoundException) {
            console.log('Table %s does not exist in %s', tableName, region);
            return false;
         }

         throw err;
      }
   }

   async _describeTableUntilState(tableName, region, desiredStates) {
      let attempts = 0,
          timeout = 2000;

      while (attempts < 10) {
         attempts = attempts + 1;

         const desc = await this._describeTable(tableName, region);

         if (desc && _.contains(desiredStates, desc.TableStatus)) {
            return desc;
         } else if (desc) {
            console.log('Table %s in %s currently %s (waiting for %s)', tableName, region, desc.TableStatus, desiredStates);
         } else {
            console.log('Table %s in %s does not yet exist (waiting for it in %s state)', tableName, region, desiredStates);
         }

         console.log('Will try describing %s in %s again in %s seconds', tableName, region, (timeout / 1000));
         await delay(timeout);
         timeout = Math.min(10000, timeout * 1.5);
      }

      // eslint-disable-next-line max-len
      throw new Error(util.format('ERROR: Exhausted all %d attempts waiting for %s:%s to be %s', attempts, tableName, region, desiredStates));
   }

   async _printDescriptionsOfTables(tableName, regions) {
      return Promise.all(_.map(regions, async (region) => {
         const resp = await this._describeTable(tableName, region);

         console.log('Table description for %s:%s: %j', tableName, region, resp);
      }));
   }

   _hasRequiredStreamSpec(desc) {
      return desc.StreamSpecification &&
         desc.StreamSpecification.StreamEnabled &&
         desc.StreamSpecification.StreamViewType === 'NEW_AND_OLD_IMAGES';
   }

   _makeCreateTableParamsFromDescription(desc) {
      const params = _.pick(desc, 'AttributeDefinitions', 'KeySchema', 'TableName', 'StreamSpecification'),
            srcBillingMode = (desc.BillingModeSummary ? desc.BillingModeSummary.BillingMode : null);

      if (srcBillingMode) {
         params.BillingMode = srcBillingMode;
      }
      if (srcBillingMode !== 'PAY_PER_REQUEST') {
         params.ProvisionedThroughput = _.pick(desc.ProvisionedThroughput, 'ReadCapacityUnits', 'WriteCapacityUnits');
      }

      if (!_.isEmpty(desc.LocalSecondaryIndexes)) {
         params.LocalSecondaryIndexes = _.map(desc.LocalSecondaryIndexes, (lsi) => {
            return _.pick(lsi, 'IndexName', 'KeySchema', 'Projection');
         });
      }

      if (!_.isEmpty(desc.GlobalSecondaryIndexes)) {
         params.GlobalSecondaryIndexes = _.map(desc.GlobalSecondaryIndexes, (gsi) => {
            const newGSI = _.pick(gsi, 'IndexName', 'KeySchema', 'Projection');

            if (srcBillingMode !== 'PAY_PER_REQUEST') {
               newGSI.ProvisionedThroughput = _.pick(gsi.ProvisionedThroughput, 'ReadCapacityUnits', 'WriteCapacityUnits');
            }
            return newGSI;
         });
      }

      return params;
   }

   _makeUpdateTableParams(tableName, destRegion, master, dest) {
      const params = _.pick(master, 'AttributeDefinitions', 'TableName'),
            destParams = _.pick(dest, 'AttributeDefinitions', 'TableName'),
            srcBillingMode = (master.BillingModeSummary ? master.BillingModeSummary.BillingMode : null),
            destBillingMode = (dest.BillingModeSummary ? dest.BillingModeSummary.BillingMode : null),
            baseParamsAreEqual = _.isEqual(params, destParams) && (srcBillingMode === destBillingMode),
            indexesBeingUpdated = [];

      // NOTE: on updates we do not copy the provisioned throughput from the master table
      // because we never manage throughput through CloudFormation ... we always intend to
      // either manage it with our own DynamoDB Capacity Manager (via the
      // core:dynamo-provisioning service), or through AWS' own auto-scaling. We would not
      // want to compare the current provisioned capacity of the master and dest table and
      // copy them here because we could cause errors.

      // Similarly, we do not update the stream status because it should never change
      // after the initial creation since global tables require a specific type of stream.

      if (srcBillingMode && srcBillingMode !== destBillingMode) {
         params.BillingMode = srcBillingMode;
      }

      // The provisioned throughput setting should only be copied when switching a table
      // from on-demand to provisioned. In this case, the table needs an "initial"
      // throughput set. However, in all other cases we don't want to copy this value (see
      // the note above)
      if (srcBillingMode !== 'PAY_PER_REQUEST' && destBillingMode === 'PAY_PER_REQUEST') {
         params.ProvisionedThroughput = _.pick(master.ProvisionedThroughput, 'ReadCapacityUnits', 'WriteCapacityUnits');
      }

      params.GlobalSecondaryIndexUpdates = [];

      // Find indexes on the master table that are deleting (and need to be deleted on the
      // destination table), or are missing on the destination and thus need to be
      // created.
      _.each(master.GlobalSecondaryIndexes, (masterGSI) => {
         const destGSI = _.findWhere(dest.GlobalSecondaryIndexes, { IndexName: masterGSI.IndexName });

         let gsiUpdate;

         if (destGSI && masterGSI.IndexStatus === 'DELETING') {
            console.log(
               'Need to delete index %s:%s in %s because it exists on dest table and is DELETING on the master table',
               tableName,
               masterGSI.IndexName,
               destRegion
            );

            params.GlobalSecondaryIndexUpdates.push({ Delete: _.pick(masterGSI, 'IndexName') });
            indexesBeingUpdated.push(masterGSI.IndexName);
         } else if (!destGSI) {
            console.log('Need to create index %s:%s in %s', tableName, masterGSI.IndexName, destRegion);
            gsiUpdate = { Create: _.pick(masterGSI, 'IndexName', 'KeySchema', 'Projection') };
            if (srcBillingMode !== 'PAY_PER_REQUEST') {
               gsiUpdate.Create.ProvisionedThroughput = _.pick(masterGSI.ProvisionedThroughput, 'ReadCapacityUnits', 'WriteCapacityUnits');
            }
            params.GlobalSecondaryIndexUpdates.push(gsiUpdate);
            indexesBeingUpdated.push(masterGSI.IndexName);
         }
      });

      // If the source table's billing mode is 'PROVISIONED', but the destination table's
      // mode is 'PAY_PER_REQUEST', then we will be changing it to PROVISIONED, and thus
      // need to update all the indexes to include the provisioned capacity.
      // Note that there's some oddness here: when the table's billing mode is
      // 'PROVISIONED', you may not actually get back the BillingModeSummary in the table
      // description. That's why we use `srcBillingMode !== 'PAY_PER_REQUEST'` everywhere
      // in this class - because if it's pay per request, you'll always get the billing
      // mode back.
      if (srcBillingMode !== 'PAY_PER_REQUEST' && destBillingMode === 'PAY_PER_REQUEST') {
         _.each(master.GlobalSecondaryIndexes, (masterGSI) => {
            if (_.contains(indexesBeingUpdated, masterGSI.IndexName) || masterGSI.IndexStatus === 'DELETING') {
               // This index is already in our call params, or it's being deleted.
               return;
            }

            params.GlobalSecondaryIndexUpdates.push({
               Update: {
                  IndexName: masterGSI.IndexName,
                  ProvisionedThroughput: _.pick(masterGSI.ProvisionedThroughput, 'ReadCapacityUnits', 'WriteCapacityUnits'),
               },
            });
         });
      }

      // Now find indexes that only the destination table has, since they must have been
      // deleted from the master table.
      _.each(dest.GlobalSecondaryIndexes, (destGSI) => {
         const masterGSI = _.findWhere(master.GlobalSecondaryIndexes, { IndexName: destGSI.IndexName });

         if (!masterGSI) {
            console.log(
               'Need to delete index %s:%s in %s because it exists on dest table and does not exist on master table',
               tableName,
               destGSI.IndexName,
               destRegion
            );

            params.GlobalSecondaryIndexUpdates.push({ Delete: _.pick(destGSI, 'IndexName') });
         }
      });


      if (baseParamsAreEqual && _.isEmpty(params.GlobalSecondaryIndexUpdates)) {
         // There are no updates to be made
         console.log('There are no updates to be made to %s in %s', tableName, destRegion);
         return false;
      } else if (_.isEmpty(params.GlobalSecondaryIndexUpdates)) {
         console.log('There are no GlobalSecondaryIndexUpdates to be made to %s in %s', tableName, destRegion);
         delete params.GlobalSecondaryIndexUpdates;
      }

      return params;
   }

   async _ensureGlobalTableConsistent(props) {
      const tableName = props.GlobalTableName,
            desc = await this._describeGlobalTable(tableName);

      if (desc) {
         return this._updateGlobalTable(props, desc);
      }

      return this._createGlobalTable(props);
   }

   async _createGlobalTable(props) {
      await this._waitForTablesCreatingOrActive(props.GlobalTableName, _.pluck(props.ReplicationGroup, 'RegionName'));

      const params = _.pick(props, 'GlobalTableName', 'ReplicationGroup');

      console.log('Creating global table: %j', params);
      const resp = await dynamo.send(new CreateGlobalTableCommand(params));

      console.log('createGlobalTable response: %j', resp);
      return { PhysicalResourceId: props.GlobalTableName, Arn: resp.GlobalTableDescription.GlobalTableArn };
   }

   async _updateGlobalTable(props, desc) {
      const tableName = props.GlobalTableName,
            desiredRegions = _.pluck(props.ReplicationGroup, 'RegionName'),
            existingRegions = _.pluck(desc.ReplicationGroup, 'RegionName'),
            params = { GlobalTableName: tableName, ReplicaUpdates: [] };

      console.log('Updating global table %s to match props %j', tableName, props);
      console.log('The description of the current global table %s is: %j', tableName, desc);

      // add missing regions:
      _.each(_.difference(desiredRegions, existingRegions), (region) => {
         params.ReplicaUpdates.push({ Create: { RegionName: region } });
      });

      // remove extra regions:
      _.each(_.difference(existingRegions, desiredRegions), (region) => {
         params.ReplicaUpdates.push({ Delete: { RegionName: region } });
      });

      if (_.isEmpty(params.ReplicaUpdates)) {
         console.log('No update needed for global table %s', tableName);
         return { PhysicalResourceId: props.GlobalTableName, Arn: desc.GlobalTableArn };
      }

      await this._waitForTablesCreatingOrActive(tableName, desiredRegions.concat(existingRegions));

      console.log('Updating global table %s with params: %j', tableName, params);
      await dynamo.send(new UpdateGlobalTableCommand(params));

      return { PhysicalResourceId: props.GlobalTableName, Arn: desc.GlobalTableArn };
   }

   async _waitForTablesCreatingOrActive(tableName, regions) {
      // Whenever you modify a global table, all of the tables in the global table
      // replication group must be in either CREATING or ACTIVE state. Often when a table
      // is first created it will temporarily change CREATING -> ACTIVE -> UPDATING, and
      // then back to ACTIVE. If we happen to try to updateGlobalTable before the table is
      // ACTIVE, we will get an error.
      console.log('Waiting for %s in %s to be CREATING or ACTIVE', tableName, regions);
      return Promise.all(_.map(regions, (region) => {
         return this._describeTableUntilState(tableName, region, [ 'CREATING', 'ACTIVE' ]);
      }));
   }

   async _describeGlobalTable(tableName) {
      try {
         const resp = await dynamo.send(new DescribeGlobalTableCommand({ GlobalTableName: tableName }));

         return resp.GlobalTableDescription;
      } catch(err) {
         if (err instanceof GlobalTableNotFoundException) {
            return false;
         }

         throw err;
      }
   }

}

module.exports = DynamoDBGlobalTable;
