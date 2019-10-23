'use strict';

var BaseResource = require('./BaseResource'),
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

   doUpdate: function(resourceID) {
      throw new Error(`Updates to ElasticSearch indices are not supported (${resourceID})`);
   },

});
