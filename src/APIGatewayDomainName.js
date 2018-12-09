'use strict';

var _ = require('underscore'),
    Q = require('q'),
    AWS = require('aws-sdk'),
    apigw = new AWS.APIGateway(),
    BaseResource = require('./BaseResource');

module.exports = BaseResource.extend({

   doCreate: function(props) {
      return Q.ninvoke(apigw, 'createDomainName', _.omit(props, 'ServiceToken'))
         .then(function(resp) {
            return { PhysicalResourceId: resp.domainName, regionalDomainName: resp.regionalDomainName };
         });
   },

   doDelete: function(resourceID) {
      return Q.ninvoke(apigw, 'deleteDomainName', { domainName: resourceID })
         .catch(function(e) {
            // If the domain wasn't found, that means it may never have been created
            // (perhaps due to some error), and thus doesn't need to be deleted.
            if (e && e.code === 'NotFoundException') {
               return;
            }
            throw e;
         })
         .thenResolve({ PhysicalResourceId: resourceID });
   },

   doUpdate: function(resourceID) {
      throw new Error(`Updates for custom domains are not supported (${resourceID})`);
   },

});
