'use strict';

const _ = require('underscore'),
      BaseResource = require('./BaseResource');

const {
   DynamoDBClient,
   CreateGlobalTableCommand,
   UpdateGlobalTableCommand,
   DescribeGlobalTableCommand,
} = require('@aws-sdk/client-dynamodb');

const dynamo = new DynamoDBClient({});

class SimpleDynamoDBGlobalTable extends BaseResource {

   normalizeResourceProperties(props) {
      if (props.Regions) {
         props.ReplicationGroup = _.map(props.Regions, (dr) => {
            return { RegionName: dr.region };
         });
      }

      return props;
   }

   async doCreate(props) {
      const params = _.pick(props, 'GlobalTableName', 'ReplicationGroup');

      console.log('Creating global table: %j', params);

      const resp = await dynamo.send(new CreateGlobalTableCommand(params));

      console.log('createGlobalTable response: %j', resp);
      return { PhysicalResourceId: props.GlobalTableName, Arn: resp.GlobalTableDescription.GlobalTableArn };
   }

   async doUpdate(resourceID, props) {
      const desc = await this._describeGlobalTable(props.GlobalTableName),
            tableName = props.GlobalTableName,
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

      console.log('Updating global table %s with params: %j', tableName, params);
      await dynamo.send(new UpdateGlobalTableCommand(params));

      return { PhysicalResourceId: props.GlobalTableName, Arn: desc.GlobalTableArn };
   }

   async doDelete(resourceID, props) {
      console.log('No need to do anything to delete global table %s - just delete the tables in it', props.GlobalTableName);
      return { PhysicalResourceId: props.GlobalTableName };
   }

   async _describeGlobalTable(tableName) {
      const resp = await dynamo.send(new DescribeGlobalTableCommand({ GlobalTableName: tableName }));

      return resp.GlobalTableDescription;
   }

}

module.exports = SimpleDynamoDBGlobalTable;
