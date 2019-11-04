'use strict';

var BaseResource = require('./BaseResource'),
    ElasticSearchClient = require('./lib/ElasticSearchClient'),
    region = process.env.AWS_REGION;

module.exports = BaseResource.extend({

   doCreate: function(props) {
      const elasticSearchClient = new ElasticSearchClient(region, props.Domain);

      return elasticSearchClient
         .send('POST', '/_aliases', {
            actions: [
               { add: { index: props.Target, alias: props.Name } },
            ],
         })
         .then(() => {
            return {};
         });
   },

   doDelete: function(resourceID, props) {
      const elasticSearchClient = new ElasticSearchClient(region, props.Domain);

      return elasticSearchClient
         .send('POST', '/_aliases', {
            actions: [
               { remove: { index: props.Target, alias: props.Name } },
            ],
         })
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
      const elasticSearchClient = new ElasticSearchClient(region, props.Domain);

      return elasticSearchClient
         .send('POST', '/_aliases', {
            actions: [
               { remove: { index: oldProps.Target, alias: oldProps.Name } },
               { add: { index: props.Target, alias: props.Name } },
            ],
         })
         .then(() => {
            return {};
         });
   },

});
