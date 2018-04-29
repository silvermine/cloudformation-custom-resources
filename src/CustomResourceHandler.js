'use strict';

var _ = require('underscore'),
    Q = require('q'),
    handler = require('silvermine-lambda-utils/callPromiseFunctionIgnoreResolvedValueHandler'),
    BaseResource = require('./BaseResource'),
    resources;

resources = {
   KMSKeyGrant: require('./KMSKeyGrant'), // eslint-disable-line global-require
   SNSSQSSubscription: require('./SNSSQSSubscription'), // eslint-disable-line global-require
   CloudFrontOriginAccessIdentity: require('./CloudFrontOriginAccessIdentity'), // eslint-disable-line global-require
   DynamoDBGlobalTable: require('./DynamoDBGlobalTable'), // eslint-disable-line global-require
   SimpleEmailServiceDomainVerification: require('./SimpleEmailServiceDomainVerification'), // eslint-disable-line global-require
   SimpleEmailServiceRuleSetActivation: require('./SimpleEmailServiceRuleSetActivation'), // eslint-disable-line global-require
   APIGatewayDomainName: require('./APIGatewayDomainName'), // eslint-disable-line global-require
};

module.exports = {

   // invoked by CloudFormation stack creates / updates / deletes
   handler: function(evt, context, cb) {
      var type = evt.ResourceType.replace(/^Custom::/, ''),
          Resource, resource, fn;

      console.log('custom resource event: %j', evt);

      if (_.has(resources, type)) {
         // possible RequestType values: Create / Update / Delete
         Resource = resources[type];
         resource = new Resource(evt);
         fn = function() {
            return Q.promised(resource['handle' + evt.RequestType].bind(resource))()
               .catch(resource.sendError.bind(resource));
         };
      } else {
         resource = new BaseResource(evt);
         fn = resource.sendError.bind(resource, new Error('Unsupported resource type: ' + type));
      }

      handler(fn, context, cb);
   },

};
