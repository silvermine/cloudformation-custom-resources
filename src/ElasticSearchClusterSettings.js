'use strict';

var BaseResource = require('./BaseResource'),
    ElasticSearchClient = require('./lib/ElasticSearchClient'),
    region = process.env.AWS_REGION;

module.exports = BaseResource.extend({

   doCreate: function(props) {
      return this._updateClusterSettings(props);
   },

   doUpdate: function(resourceID, props) {
      return this._updateClusterSettings(props);
   },

   _updateClusterSettings: async function(props) {
      const elasticSearchClient = new ElasticSearchClient(region, props.Domain);

      return elasticSearchClient
         .send('PUT', '/_cluster/settings', {
            persistent: {
               'action.auto_create_index': props.AutoCreateIndex || false,
            },
         })
         .then(() => {
            return {};
         });
   },

});
