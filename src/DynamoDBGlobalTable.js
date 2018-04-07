'use strict';

var _ = require('underscore'),
    Q = require('q'),
    AWS = require('aws-sdk'),
    util = require('util'),
    dynamo = new AWS.DynamoDB(),
    BaseResource = require('./BaseResource'),
    AWS_REGION = process.env.AWS_REGION;

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

   doCreate: function(props) {
      var tableName = props.GlobalTableName,
          allRegions = _.pluck(props.ReplicationGroup, 'RegionName'),
          copyTableRegions = _.chain(props.ReplicationGroup).pluck('RegionName').without(AWS_REGION).value();

      console.log('Pausing ten seconds before starting create for global table %s in regions %s', tableName, allRegions);
      return Q.delay(10000)
         .then(this._ensureTableCopiedToRegions.bind(this, tableName, copyTableRegions))
         .then(this._printDescriptionsOfTables.bind(this, tableName, allRegions)) // for helpful debugging
         .then(this._ensureGlobalTableConsistent.bind(this, props));
   },

   doUpdate: function(resourceID, props, oldProps) {
      var tableName = props.GlobalTableName,
          allRegions = _.pluck(props.ReplicationGroup, 'RegionName'),
          oldRegions = _.pluck(oldProps.ReplicationGroup, 'RegionName'),
          copyTableRegions = _.without(allRegions, AWS_REGION),
          oldCopyTableRegions = _.without(oldRegions, AWS_REGION);

      console.log('Pausing ten seconds before starting update for global table %s in regions %s', tableName, allRegions);
      return Q.delay(10000)
         .then(this._ensureTableCopiedToRegions.bind(this, tableName, copyTableRegions))
         .then(this._printDescriptionsOfTables.bind(this, tableName, _.uniq(allRegions.concat(oldRegions)))) // for helpful debugging
         .then(this._ensureGlobalTableConsistent.bind(this, props))
         .then(function(globalTableCloudFormationResp) {
            var regionsToDelete = _.difference(oldCopyTableRegions, copyTableRegions);

            if (props.DeleteUnneededTables) {
               return this._removeTableFromRegions(tableName, regionsToDelete)
                  .then(_.constant(globalTableCloudFormationResp));
            }

            console.log('Not deleting table %s from regions %s because DeleteUnneededTables was not truthy', tableName, regionsToDelete);
            return globalTableCloudFormationResp;
         }.bind(this));
   },

   doDelete: function(resourceID, props) {
      var tableName = props.GlobalTableName,
          copyTableRegions = _.chain(props.ReplicationGroup).pluck('RegionName').without(AWS_REGION).value();

      if (props.DeleteUnneededTables) {
         return this._removeTableFromRegions(tableName, copyTableRegions)
            .then(_.constant({ PhysicalResourceId: props.GlobalTableName }));
      }

      console.log('Not deleting replica %s tables in %s because DeleteUnneededTables was not truthy', tableName, copyTableRegions);
      return Q.when({ PhysicalResourceId: props.GlobalTableName });
   },

   _ensureTableCopiedToRegions: function(tableName, regions) {
      var self = this;

      // Wait for the table to be in any state but DELETING:
      return this._describeTableUntilState(tableName, AWS_REGION, [ 'CREATING', 'ACTIVE', 'UPDATING' ])
         .then(function(masterDesc) {
            if (!self._hasRequiredStreamSpec(masterDesc)) {
               throw new Error('The master table ' + tableName + ' does not have the required NEW_AND_OLD_IMAGES stream enabled');
            }

            return self._listTags(AWS_REGION, masterDesc.TableArn)
               .then(function(tags) {
                  return Q.all(_.map(regions, self._ensureTableCopiedToRegion.bind(self, tableName, masterDesc, tags)));
               });
         });
   },

   _ensureTableCopiedToRegion: function(tableName, masterDesc, masterTags, region) {
      var self = this,
          dyn = new AWS.DynamoDB({ region: region });

      return this._describeTable(tableName, region)
         .then(function(copyDesc) {
            var params;

            if (copyDesc) {
               params = self._makeUpdateTableParams(tableName, region, masterDesc, copyDesc);

               if (params) {
                  console.log('Updating a copy of DynamoDB table %s in %s: %j', tableName, region, params);
                  return Q.ninvoke(dyn, 'updateTable', params);
               }
            } else {
               params = self._makeCreateTableParamsFromDescription(masterDesc);
               console.log('Creating a copy of DynamoDB table %s in %s: %j', tableName, region, params);
               return Q.ninvoke(dyn, 'createTable', params);
            }

            return { TableDescription: copyDesc };
         })
         .then(function(createOrUpdateResp) {
            var arn = createOrUpdateResp.TableDescription.TableArn;

            return self._listTags(region, arn)
               .then(function(copyTags) {
                  if (_.isEqual(masterTags, copyTags)) {
                     console.log('No change needed for tags on %s in %s: %j', tableName, region, copyTags);
                     return;
                  }

                  console.log('Tagging table %s in %s with tags %j', tableName, region, masterTags);
                  return Q.ninvoke(dyn, 'tagResource', { ResourceArn: arn, Tags: masterTags });
               });
         });
   },

   _listTags: function(region, arn) {
      var def = Q.defer(),
          dyn = (region === AWS_REGION) ? dynamo : new AWS.DynamoDB({ region: region }),
          attempts = 0,
          timeout = 2000;

      function doOnce() {
         attempts = attempts + 1;

         return Q.ninvoke(dyn, 'listTagsOfResource', { ResourceArn: arn })
            .catch(function(err) {
               if (err.code === 'ResourceNotFoundException') {
                  console.log('Could not list tags for %s because of ResourceNotFoundException', arn);
                  return false;
               }

               throw err;
            })
            .then(function(tagsResp) {
               if (tagsResp) {
                  if (tagsResp.NextToken) {
                     def.reject(new Error('Too many tags on table ' + arn + ' for this simplistic tag replication'));
                     return;
                  }

                  def.resolve(tagsResp.Tags);
                  return;
               }

               // We allow 15 attempts here (as opposed to 10 when waiting on tables in
               // certain states) because it seems to take longer for the
               // list-tags-of-resource operation to start showing a new table.
               if (attempts < 15) {
                  console.log('Will try listing tags for %s again in %s seconds', arn, (timeout / 1000));
                  Q.delay(timeout).then(doOnce).done();
                  timeout = Math.min(10000, timeout * 1.5);
               } else {
                  def.reject(new Error(util.format('ERROR: Exhausted all %d attempts waiting for %s to have tags', attempts, arn)));
               }
            })
            .catch(def.reject.bind(def));
      }

      Q.nextTick(doOnce);

      return def.promise;
   },

   _removeTableFromRegions: function(tableName, regions) {
      var self = this;

      if (_.contains(regions, AWS_REGION)) {
         throw new Error('Should not delete table %s from master region %s', tableName, AWS_REGION);
      }

      return Q.all(_.map(regions, function(region) {
         var dyn = new AWS.DynamoDB({ region: region });

         return self._describeTable(tableName, region)
            .then(function(desc) {
               if (desc) {
                  console.log('Deleting table %s in region %s', tableName, region);
                  return Q.ninvoke(dyn, 'deleteTable', { TableName: tableName })
                     .then(function() {
                        console.log('Done deleting table %s in region %s', tableName, region);
                     });

               }
            });
      }));
   },

   _describeTable: function(tableName, region) {
      var dyn = (region === AWS_REGION) ? dynamo : new AWS.DynamoDB({ region: region });

      return Q.ninvoke(dyn, 'describeTable', { TableName: tableName })
         .catch(function(err) {
            if (err.code === 'ResourceNotFoundException') {
               console.log('Table %s does not exist in %s', tableName, region);
               return false;
            }

            throw err;
         })
         .then(function(resp) {
            return resp ? resp.Table : resp;
         });
   },

   _describeTableUntilState: function(tableName, region, desiredStates) {
      var self = this,
          def = Q.defer(),
          attempts = 0,
          timeout = 2000;

      function doOnce() {
         attempts = attempts + 1;

         return self._describeTable(tableName, region)
            .then(function(desc) {
               if (desc && _.contains(desiredStates, desc.TableStatus)) {
                  // Have table, and it's in the desired state ... done!
                  return def.resolve(desc);
               } else if (desc) {
                  // Have table, but not in valid state ... try again
                  console.log('Table %s in %s currently %s (waiting for %s)', tableName, region, desc.TableStatus, desiredStates);
               } else {
                  // Don't have table yet ... try again
                  console.log('Table %s in %s does not yet exist (waiting for it in %s state)', tableName, region, desiredStates);
               }

               if (attempts < 10) {
                  console.log('Will try describing %s in %s again in %s seconds', tableName, region, (timeout / 1000));
                  Q.delay(timeout).then(doOnce).done();
                  timeout = Math.min(10000, timeout * 1.5);
               } else {
                  // eslint-disable-next-line max-len
                  def.reject(new Error(util.format('ERROR: Exhausted all %d attempts waiting for %s:%s to be %s', attempts, tableName, region, desiredStates)));
               }
            })
            .catch(def.reject.bind(def));
      }

      Q.nextTick(doOnce);

      return def.promise;
   },

   _printDescriptionsOfTables: function(tableName, regions) {
      return Q.all(_.map(regions, function(region) {
         return this._describeTable(tableName, region)
            .then(function(resp) {
               console.log('Table description for %s:%s: %j', tableName, region, resp);
            });
      }.bind(this)));
   },

   _hasRequiredStreamSpec: function(desc) {
      return desc.StreamSpecification &&
         desc.StreamSpecification.StreamEnabled &&
         desc.StreamSpecification.StreamViewType === 'NEW_AND_OLD_IMAGES';
   },

   _makeCreateTableParamsFromDescription: function(desc) {
      var params = _.pick(desc, 'AttributeDefinitions', 'KeySchema', 'TableName', 'StreamSpecification');

      params.ProvisionedThroughput = _.pick(desc.ProvisionedThroughput, 'ReadCapacityUnits', 'WriteCapacityUnits');

      if (!_.isEmpty(desc.LocalSecondaryIndexes)) {
         params.LocalSecondaryIndexes = _.map(desc.LocalSecondaryIndexes, function(lsi) {
            return _.pick(lsi, 'IndexName', 'KeySchema', 'Projection');
         });
      }

      if (!_.isEmpty(desc.GlobalSecondaryIndexes)) {
         params.GlobalSecondaryIndexes = _.map(desc.GlobalSecondaryIndexes, function(gsi) {
            var newGSI = _.pick(gsi, 'IndexName', 'KeySchema', 'Projection');

            newGSI.ProvisionedThroughput = _.pick(gsi.ProvisionedThroughput, 'ReadCapacityUnits', 'WriteCapacityUnits');
            return newGSI;
         });
      }

      return params;
   },

   _makeUpdateTableParams: function(tableName, destRegion, master, dest) {
      var params = _.pick(master, 'AttributeDefinitions', 'TableName'),
          destParams = _.pick(dest, 'AttributeDefinitions', 'TableName'),
          baseParamsAreEqual = _.isEqual(params, destParams);

      // NOTE: on updates we do not copy the provisioned throughput from the master table
      // because we never manage throughput through CloudFormation ... we always intend to
      // either manage it with our own DynamoDB Capacity Manager (via the
      // core:dynamo-provisioning service), or through AWS' own auto-scaling. We would not
      // want to compare the current provisioned capacity of the master and dest table and
      // copy them here because we could cause errors.

      // Similarly, we do not update the stream status because it should never change
      // after the initial creation since global tables require a specific type of stream.

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
         } else if (!destGSI) {
            console.log('Need to create index %s:%s in %s', tableName, masterGSI.IndexName, destRegion);
            gsiUpdate = { Create: _.pick(masterGSI, 'IndexName', 'KeySchema', 'Projection') };
            gsiUpdate.Create.ProvisionedThroughput = _.pick(masterGSI.ProvisionedThroughput, 'ReadCapacityUnits', 'WriteCapacityUnits');
            params.GlobalSecondaryIndexUpdates.push(gsiUpdate);
         }
      });

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

   _ensureGlobalTableConsistent: function(props) {
      var tableName = props.GlobalTableName;

      return this._describeGlobalTable(tableName)
         .then(function(desc) {
            if (desc) {
               return this._updateGlobalTable(props, desc);
            }

            return this._createGlobalTable(props);
         }.bind(this));
   },

   _createGlobalTable: function(props) {
      return this._waitForTablesCreatingOrActive(props.GlobalTableName, _.pluck(props.ReplicationGroup, 'RegionName'))
         .then(function() {
            var params = _.pick(props, 'GlobalTableName', 'ReplicationGroup');

            console.log('Creating global table: %j', params);
            return Q.ninvoke(dynamo, 'createGlobalTable', params);
         })
         .then(function(resp) {
            console.log('createGlobalTable response: %j', resp);
            return { PhysicalResourceId: props.GlobalTableName, Arn: resp.GlobalTableDescription.GlobalTableArn };
         });
   },

   _updateGlobalTable: function(props, desc) {
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
         return Q.when({ PhysicalResourceId: props.GlobalTableName, Arn: desc.GlobalTableArn });
      }

      return this._waitForTablesCreatingOrActive(tableName, desiredRegions.concat(existingRegions))
         .then(function() {
            console.log('Updating global table %s with params: %j', tableName, params);
            return Q.ninvoke(dynamo, 'updateGlobalTable', params);
         })
         .then(_.constant({ PhysicalResourceId: props.GlobalTableName, Arn: desc.GlobalTableArn }));
   },

   _waitForTablesCreatingOrActive: function(tableName, regions) {
      // Whenever you modify a global table, all of the tables in the global table
      // replication group must be in either CREATING or ACTIVE state. Often when a table
      // is first created it will temporarily change CREATING -> ACTIVE -> UPDATING, and
      // then back to ACTIVE. If we happen to try to updateGlobalTable before the table is
      // ACTIVE, we will get an error.
      console.log('Waiting for %s in %s to be CREATING or ACTIVE', tableName, regions);
      return Q.all(_.map(regions, function(region) {
         return this._describeTableUntilState(tableName, region, [ 'CREATING', 'ACTIVE' ]);
      }.bind(this)));
   },

   _describeGlobalTable: function(tableName) {
      return Q.ninvoke(dynamo, 'describeGlobalTable', { GlobalTableName: tableName })
         .then(function(resp) {
            return resp.GlobalTableDescription;
         })
         .catch(function(err) {
            if (err.code === 'GlobalTableNotFoundException') {
               return false;
            }

            throw err;
         });
   },

});
