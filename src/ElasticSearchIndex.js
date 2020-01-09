'use strict';

var _ = require('underscore'),
    BaseResource = require('./BaseResource'),
    ElasticSearchClient = require('./lib/ElasticSearchClient'),
    region = process.env.AWS_REGION;

module.exports = BaseResource.extend({

   doCreate: function(props) {
      const elasticSearchClient = new ElasticSearchClient(region, props.Domain);

      return elasticSearchClient
         .send('PUT', `/${props.Name}`, {
            settings: props.Settings,
            mappings: {
               properties: props.Mapping,
            },
         })
         .then(() => {
            return {};
         });
   },

   doDelete: function(resourceID, props) {
      const elasticSearchClient = new ElasticSearchClient(region, props.Domain);

      return elasticSearchClient.send('DELETE', `/${props.Name}`)
         .catch((err) => {
            // No need to fail when trying to delete something that doesn't exist.
            if (err.statusCode !== 404) {
               throw err;
            }
         })
         .then(() => {
            return {};
         });
   },

   doUpdate: function(resourceID, props, oldProps) {
      const elasticSearchClient = new ElasticSearchClient(region, props.Domain),
            // Clone the incoming props so we can remove and compare the props that cannot
            // be updated (NOTE: there are probably other properties that can be updated
            // that this code is not allowing updates for. If you need this resource to be
            // able to update another prop, please check the Elasticsearch docs [1] and
            // then submit a PR to this plugin)
            // [1]: https://www.elastic.co/guide/en/elasticsearch/reference/7.1/index-modules.html
            immutableNewProps = JSON.parse(JSON.stringify(props)),
            immutableOldProps = JSON.parse(JSON.stringify(oldProps));

      // Remove the properties that *can* be updated
      delete immutableNewProps.Settings.number_of_replicas;
      delete immutableNewProps.Mapping;
      delete immutableOldProps.Settings.number_of_replicas;
      delete immutableOldProps.Mapping;

      // Then check to see if any of the properties that remain (i.e. those that cannot be
      // updated) were changed
      if (!_.isEqual(immutableNewProps, immutableOldProps)) {
         // Log the old vs new props rather than putting the data in the error message as
         // the response can only 4,096 bytes long. See:
         // https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cloudformation-limits.html
         console.log(
            `ERROR Not updating ${resourceID} as one or more of the changed fields does not support updates`
            + ` Old: ${JSON.stringify(immutableOldProps)} New: ${JSON.stringify(immutableNewProps)}`
         );
         throw new Error(`One or more of the changed fields does not support updates (${resourceID})`);
      }

      let promises = [];

      if (props.Settings.number_of_replicas !== oldProps.Settings.number_of_replicas) {
         promises.push(
            elasticSearchClient.send('PUT', `/${props.Name}/_settings`, {
               settings: {
                  'number_of_replicas': props.Settings.number_of_replicas,
               },
            })
         );
      }

      if (!_.isEqual(props.Mapping, oldProps.Mapping)) {
         promises.push(
            elasticSearchClient.send('PUT', `/${props.Name}/_mappings`, {
               properties: props.Mapping,
            })
         );
      }

      return Promise.all(promises)
         .then(() => {
            return {};
         });
   },

});
