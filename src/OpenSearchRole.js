'use strict';

const BaseResource = require('./BaseResource'),
      ElasticSearchClient = require('./lib/ElasticSearchClient'),
      region = process.env.AWS_REGION,
      rolesURL = '/_plugins/_security/api/roles';

module.exports = BaseResource.extend({

   doCreate: function(props) {
      const client = new ElasticSearchClient(region, props.Domain);

      return client.send('PUT', `${rolesURL}/${props.RoleName}`, props.RoleDefinition)
         .then(() => {
            return {};
         });
   },

   doUpdate: function(physicalResourceId, props) {
      const client = new ElasticSearchClient(region, props.Domain);

      return client.send('PUT', `${rolesURL}/${props.RoleName}`, props.RoleDefinition)
         .then(() => {
            return {};
         });
   },

   doDelete: function(physicalResourceId, props) {
      const client = new ElasticSearchClient(region, props.Domain);

      return client.send('DELETE', `${rolesURL}/${props.RoleName}`)
         .then(() => {
            return {};
         });
   },
});
