'use strict';

var _ = require('underscore'),
    Q = require('q'),
    AWS = require('aws-sdk'),
    dynamo = new AWS.DynamoDB(),
    BaseResource = require('./BaseResource');

module.exports = BaseResource.extend({

   normalizeResourceProperties: function(props) {
      if (props.Regions) {
         props.ReplicationGroup = _.map(props.Regions, function(dr) {
            return { RegionName: dr.region };
         });
      }

      return props;
   },

   doCreate: function(props) {
      var params = _.pick(props, 'GlobalTableName', 'ReplicationGroup');

      console.log('Creating global table: %j', params);

      return Q.ninvoke(dynamo, 'createGlobalTable', params)
         .then(function(resp) {
            console.log('createGlobalTable response: %j', resp);
            return { PhysicalResourceId: props.GlobalTableName, Arn: resp.GlobalTableDescription.GlobalTableArn };
         });
   },

   doUpdate: async function(resourceID, props) {
      return this._describeGlobalTable(props.GlobalTableName)
         .then(function(desc) {
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

            console.log('Updating global table %s with params: %j', tableName, params);
            return Q.ninvoke(dynamo, 'updateGlobalTable', params)
               .then(_.constant({ PhysicalResourceId: props.GlobalTableName, Arn: desc.GlobalTableArn }));
         });
   },

   doDelete: function(resourceID, props) {
      console.log('No need to do anything to delete global table %s - just delete the tables in it', props.GlobalTableName);
      return Q.when({ PhysicalResourceId: props.GlobalTableName });
   },

   _describeGlobalTable: function(tableName) {
      return Q.ninvoke(dynamo, 'describeGlobalTable', { GlobalTableName: tableName })
         .then(function(resp) {
            return resp.GlobalTableDescription;
         });
   },

});
