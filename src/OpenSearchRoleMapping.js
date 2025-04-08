'use strict';

const BaseResource = require('./BaseResource'),
      ElasticSearchClient = require('./lib/ElasticSearchClient'),
      region = process.env.AWS_REGION,
      roleMappingURL = '/_plugins/_security/api/rolesmapping';

module.exports = BaseResource.extend({
   doCreate: function(props) {
      const client = new ElasticSearchClient(region, props.Domain);

      return client.send('PUT', `${roleMappingURL}/${props.RoleName}`, props.RoleMapping)
         .then(() => {
            return {};
         });
   },

   doUpdate: function(physicalResourceId, props) {
      const client = new ElasticSearchClient(region, props.Domain);

      return client.send('PUT', `${roleMappingURL}/${props.RoleName}`, props.RoleMapping)
         .then(() => {
            return {};
         });
   },

   doDelete: function(physicalResourceId, props) {
      const client = new ElasticSearchClient(region, props.Domain);

      return client.send('DELETE', `${roleMappingURL}/${props.RoleName}`)
         .then(() => {
            return {};
         });
   },
});
