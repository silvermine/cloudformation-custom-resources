'use strict';

var _ = require('underscore'),
    util = require('util'),
    DynamoDB = require('@aws-sdk/client-dynamodb'),
    dynamo = new DynamoDB.DynamoDBClient(),
    BaseResource = require('./BaseResource'),
    AWS_REGION = process.env.AWS_REGION;

function _delay(ms) {
   return new Promise(function(resolve) {
      setTimeout(resolve, ms);
   });
}

module.exports = BaseResource.extend({

   normalizeResourceProperties: function(props, allowErrors) {
      if (props.DeleteUnneededTables && props.DeleteUnneededTables === 'true') {
         props.DeleteUnneededTables = true;
      } else {
         props.DeleteUnneededTables = false;
      }

      if (props.DeploymentRegions) {
         props.ReplicationGroup = _.map(props.DeploymentRegions, function(dr) {
            return { RegionName: dr.region };
         });
      }

      if (allowErrors && !props.LastStackUpdate) {
         throw new Error('You must supply the LastStackUpdate property for global table resources. See docs.');
      }

      return props;
   },

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

   doCreate: async function(props) {
      var tableName = props.GlobalTableName,
          allRegions = _.pluck(props.ReplicationGroup, 'RegionName'),
          copyTableRegions = _.chain(props.ReplicationGroup).pluck('RegionName').without(AWS_REGION).value();

      console.log('Pausing ten seconds before starting create for global table %s in regions %s', tableName, allRegions);
      await _delay(10000);
      await this._printDescriptionsOfTables(tableName, [ AWS_REGION ]); // for helpful debugging
      await this._ensureTableCopiedToRegions(tableName, copyTableRegions);
      await this._printDescriptionsOfTables(tableName, allRegions); // for helpful debugging

      return this._ensureGlobalTableConsistent(props);
   },

   doUpdate: async function(resourceID, props, oldProps) {
      var tableName = props.GlobalTableName,
          allRegions = _.pluck(props.ReplicationGroup, 'RegionName'),
          oldRegions = _.pluck(oldProps.ReplicationGroup, 'RegionName'),
          copyTableRegions = _.without(allRegions, AWS_REGION),
          oldCopyTableRegions = _.without(oldRegions, AWS_REGION),
          globalTableCloudFormationResp, regionsToDelete;

      console.log('Pausing ten seconds before starting update for global table %s in regions %s', tableName, allRegions);
      await _delay(10000);
      await this._printDescriptionsOfTables(tableName, [ AWS_REGION ]); // for helpful debugging
      await this._ensureTableCopiedToRegions(tableName, copyTableRegions);
      await this._printDescriptionsOfTables(tableName, _.uniq(allRegions.concat(oldRegions))); // for helpful debugging
      globalTableCloudFormationResp = await this._ensureGlobalTableConsistent(props);
      regionsToDelete = _.difference(oldCopyTableRegions, copyTableRegions);

      if (props.DeleteUnneededTables) {
         await this._removeTableFromRegions(tableName, regionsToDelete);
         return globalTableCloudFormationResp;
      }

      console.log('Not deleting table %s from regions %s because DeleteUnneededTables was not truthy', tableName, regionsToDelete);
      return globalTableCloudFormationResp;
   },

   doDelete: async function(resourceID, props) {
      var tableName = props.GlobalTableName,
          copyTableRegions = _.chain(props.ReplicationGroup).pluck('RegionName').without(AWS_REGION).value();

      if (props.DeleteUnneededTables) {
         await this._removeTableFromRegions(tableName, copyTableRegions);
         return { PhysicalResourceId: props.GlobalTableName };
      }

      console.log('Not deleting replica %s tables in %s because DeleteUnneededTables was not truthy', tableName, copyTableRegions);
      return { PhysicalResourceId: props.GlobalTableName };
   },

   _ensureTableCopiedToRegions: async function(tableName, regions) {
      var masterDesc, tags;

      // Wait for the table to be in any state but DELETING:
      masterDesc = await this._describeTableUntilState(tableName, AWS_REGION, [ 'CREATING', 'ACTIVE', 'UPDATING' ]);

      if (!this._hasRequiredStreamSpec(masterDesc)) {
         throw new Error('The master table ' + tableName + ' does not have the required NEW_AND_OLD_IMAGES stream enabled');
      }

      tags = await this._listTags(AWS_REGION, masterDesc.TableArn);

      return Promise.all(_.map(regions, this._ensureTableCopiedToRegion.bind(this, tableName, masterDesc, tags)));
   },

   _ensureTableCopiedToRegion: async function(tableName, masterDesc, masterTags, region) {
      var dyn = new DynamoDB.DynamoDBClient({ region: region }),
          copyDesc = await this._describeTable(tableName, region),
          createOrUpdateResp, params, arn, copyTags;

      if (copyDesc) {
         params = this._makeUpdateTableParams(tableName, region, masterDesc, copyDesc);

         if (params) {
            console.log('Updating a copy of DynamoDB table %s in %s: %j', tableName, region, params);
            createOrUpdateResp = await dyn.send(new DynamoDB.UpdateTableCommand(params));
         } else {
            createOrUpdateResp = { TableDescription: copyDesc };
         }
      } else {
         params = this._makeCreateTableParamsFromDescription(masterDesc);
         console.log('Creating a copy of DynamoDB table %s in %s: %j', tableName, region, params);
         createOrUpdateResp = await dyn.send(new DynamoDB.CreateTableCommand(params));
      }

      arn = createOrUpdateResp.TableDescription.TableArn;
      copyTags = await this._listTags(region, arn);

      if (_.isEqual(masterTags, copyTags)) {
         console.log('No change needed for tags on %s in %s: %j', tableName, region, copyTags);
         return;
      }

      console.log('Tagging table %s in %s with tags %j', tableName, region, masterTags);
      await dyn.send(new DynamoDB.TagResourceCommand({ ResourceArn: arn, Tags: masterTags }));
   },

   _listTags: async function(region, arn) {
      var dyn = (region === AWS_REGION) ? dynamo : new DynamoDB.DynamoDBClient({ region: region }),
          attempts = 0,
          timeout = 2000,
          tagsResp;

      while (attempts < 15) {
         attempts = attempts + 1;

         try {
            tagsResp = await dyn.send(new DynamoDB.ListTagsOfResourceCommand({ ResourceArn: arn }));
         } catch(err) {
            if (err.name === 'ResourceNotFoundException') {
               console.log('Could not list tags for %s because of ResourceNotFoundException', arn);
               tagsResp = false;
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

         // We allow 15 attempts here (as opposed to 10 when waiting on tables in
         // certain states) because it seems to take longer for the
         // list-tags-of-resource operation to start showing a new table.
         console.log('Will try listing tags for %s again in %s seconds', arn, (timeout / 1000));
         await _delay(timeout);
         timeout = Math.min(10000, timeout * 1.5);
      }

      throw new Error(util.format('ERROR: Exhausted all %d attempts waiting for %s to have tags', attempts, arn));
   },

   _removeTableFromRegions: function(tableName, regions) {
      if (_.contains(regions, AWS_REGION)) {
         throw new Error('Should not delete table %s from master region %s', tableName, AWS_REGION);
      }

      return Promise.all(_.map(regions, async function(region) {
         var dyn = new DynamoDB.DynamoDBClient({ region: region }),
             desc = await this._describeTable(tableName, region);

         if (desc) {
            console.log('Deleting table %s in region %s', tableName, region);
            await dyn.send(new DynamoDB.DeleteTableCommand({ TableName: tableName }));
            console.log('Done deleting table %s in region %s', tableName, region);
         }
      }.bind(this)));
   },

   _describeTable: async function(tableName, region) {
      var dyn = (region === AWS_REGION) ? dynamo : new DynamoDB.DynamoDBClient({ region: region }),
          resp;

      try {
         resp = await dyn.send(new DynamoDB.DescribeTableCommand({ TableName: tableName }));
      } catch(err) {
         if (err.name === 'ResourceNotFoundException') {
            console.log('Table %s does not exist in %s', tableName, region);
            return false;
         }

         throw err;
      }

      return resp.Table;
   },

   _describeTableUntilState: async function(tableName, region, desiredStates) {
      var attempts = 0,
          timeout = 2000,
          desc;

      while (attempts < 10) {
         attempts = attempts + 1;
         desc = await this._describeTable(tableName, region);

         if (desc && _.contains(desiredStates, desc.TableStatus)) {
            // Have table, and it's in the desired state ... done!
            return desc;
         } else if (desc) {
            // Have table, but not in valid state ... try again
            console.log('Table %s in %s currently %s (waiting for %s)', tableName, region, desc.TableStatus, desiredStates);
         } else {
            // Don't have table yet ... try again
            console.log('Table %s in %s does not yet exist (waiting for it in %s state)', tableName, region, desiredStates);
         }

         console.log('Will try describing %s in %s again in %s seconds', tableName, region, (timeout / 1000));
         await _delay(timeout);
         timeout = Math.min(10000, timeout * 1.5);
      }

      // eslint-disable-next-line max-len
      throw new Error(util.format('ERROR: Exhausted all %d attempts waiting for %s:%s to be %s', attempts, tableName, region, desiredStates));
   },

   _printDescriptionsOfTables: function(tableName, regions) {
      return Promise.all(_.map(regions, async function(region) {
         var resp = await this._describeTable(tableName, region);

         console.log('Table description for %s:%s: %j', tableName, region, resp);
      }.bind(this)));
   },

   _hasRequiredStreamSpec: function(desc) {
      return desc.StreamSpecification &&
         desc.StreamSpecification.StreamEnabled &&
         desc.StreamSpecification.StreamViewType === 'NEW_AND_OLD_IMAGES';
   },

   _makeCreateTableParamsFromDescription: function(desc) {
      var params = _.pick(desc, 'AttributeDefinitions', 'KeySchema', 'TableName', 'StreamSpecification'),
          srcBillingMode = (desc.BillingModeSummary ? desc.BillingModeSummary.BillingMode : null);

      if (srcBillingMode) {
         params.BillingMode = srcBillingMode;
      }
      if (srcBillingMode !== 'PAY_PER_REQUEST') {
         params.ProvisionedThroughput = _.pick(desc.ProvisionedThroughput, 'ReadCapacityUnits', 'WriteCapacityUnits');
      }

      if (!_.isEmpty(desc.LocalSecondaryIndexes)) {
         params.LocalSecondaryIndexes = _.map(desc.LocalSecondaryIndexes, function(lsi) {
            return _.pick(lsi, 'IndexName', 'KeySchema', 'Projection');
         });
      }

      if (!_.isEmpty(desc.GlobalSecondaryIndexes)) {
         params.GlobalSecondaryIndexes = _.map(desc.GlobalSecondaryIndexes, function(gsi) {
            var newGSI = _.pick(gsi, 'IndexName', 'KeySchema', 'Projection');

            if (srcBillingMode !== 'PAY_PER_REQUEST') {
               newGSI.ProvisionedThroughput = _.pick(gsi.ProvisionedThroughput, 'ReadCapacityUnits', 'WriteCapacityUnits');
            }
            return newGSI;
         });
      }

      return params;
   },

   _makeUpdateTableParams: function(tableName, destRegion, master, dest) {
      var params = _.pick(master, 'AttributeDefinitions', 'TableName'),
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
      _.each(master.GlobalSecondaryIndexes, function(masterGSI) {
         var destGSI = _.findWhere(dest.GlobalSecondaryIndexes, { IndexName: masterGSI.IndexName }),
             gsiUpdate;

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
         _.each(master.GlobalSecondaryIndexes, function(masterGSI) {
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
      _.each(dest.GlobalSecondaryIndexes, function(destGSI) {
         var masterGSI = _.findWhere(master.GlobalSecondaryIndexes, { IndexName: destGSI.IndexName });

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
   },

   _ensureGlobalTableConsistent: async function(props) {
      var tableName = props.GlobalTableName,
          desc = await this._describeGlobalTable(tableName);

      if (desc) {
         return this._updateGlobalTable(props, desc);
      }

      return this._createGlobalTable(props);
   },

   _createGlobalTable: async function(props) {
      var params, resp;

      await this._waitForTablesCreatingOrActive(props.GlobalTableName, _.pluck(props.ReplicationGroup, 'RegionName'));

      params = _.pick(props, 'GlobalTableName', 'ReplicationGroup');
      console.log('Creating global table: %j', params);

      resp = await dynamo.send(new DynamoDB.CreateGlobalTableCommand(params));
      console.log('createGlobalTable response: %j', resp);

      return { PhysicalResourceId: props.GlobalTableName, Arn: resp.GlobalTableDescription.GlobalTableArn };
   },

   _updateGlobalTable: async function(props, desc) {
      var tableName = props.GlobalTableName,
          desiredRegions = _.pluck(props.ReplicationGroup, 'RegionName'),
          existingRegions = _.pluck(desc.ReplicationGroup, 'RegionName'),
          params = { GlobalTableName: tableName, ReplicaUpdates: [] };

      console.log('Updating global table %s to match props %j', tableName, props);
      console.log('The description of the current global table %s is: %j', tableName, desc);

      // add missing regions:
      _.each(_.difference(desiredRegions, existingRegions), function(region) {
         params.ReplicaUpdates.push({ Create: { RegionName: region } });
      });

      // remove extra regions:
      _.each(_.difference(existingRegions, desiredRegions), function(region) {
         params.ReplicaUpdates.push({ Delete: { RegionName: region } });
      });

      if (_.isEmpty(params.ReplicaUpdates)) {
         console.log('No update needed for global table %s', tableName);
         return { PhysicalResourceId: props.GlobalTableName, Arn: desc.GlobalTableArn };
      }

      await this._waitForTablesCreatingOrActive(tableName, desiredRegions.concat(existingRegions));
      console.log('Updating global table %s with params: %j', tableName, params);
      await dynamo.send(new DynamoDB.UpdateGlobalTableCommand(params));

      return { PhysicalResourceId: props.GlobalTableName, Arn: desc.GlobalTableArn };
   },

   _waitForTablesCreatingOrActive: function(tableName, regions) {
      // Whenever you modify a global table, all of the tables in the global table
      // replication group must be in either CREATING or ACTIVE state. Often when a table
      // is first created it will temporarily change CREATING -> ACTIVE -> UPDATING, and
      // then back to ACTIVE. If we happen to try to updateGlobalTable before the table is
      // ACTIVE, we will get an error.
      console.log('Waiting for %s in %s to be CREATING or ACTIVE', tableName, regions);
      return Promise.all(_.map(regions, function(region) {
         return this._describeTableUntilState(tableName, region, [ 'CREATING', 'ACTIVE' ]);
      }.bind(this)));
   },

   _describeGlobalTable: async function(tableName) {
      var resp;

      try {
         resp = await dynamo.send(new DynamoDB.DescribeGlobalTableCommand({ GlobalTableName: tableName }));
         return resp.GlobalTableDescription;
      } catch(err) {
         if (err.name === 'GlobalTableNotFoundException') {
            return false;
         }

         throw err;
      }
   },

});
