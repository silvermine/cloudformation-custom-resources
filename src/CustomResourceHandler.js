'use strict';

var _ = require('underscore'),
    BaseResource = require('./BaseResource'),
    resources;

resources = {
   SNSSQSSubscription: require('./SNSSQSSubscription'), // eslint-disable-line global-require
   DynamoDBGlobalTable: require('./DynamoDBGlobalTable'), // eslint-disable-line global-require
   SimpleEmailServiceDomainVerification: require('./SimpleEmailServiceDomainVerification'), // eslint-disable-line global-require
   SimpleEmailServiceRuleSetActivation: require('./SimpleEmailServiceRuleSetActivation'), // eslint-disable-line global-require
};

module.exports = {

   // invoked by CloudFormation stack creates / updates / deletes
   handler: async function(evt) {
      var type = evt.ResourceType.replace(/^Custom::/, ''),
          Resource, resource;

      console.log('custom resource event: %j', evt);

      if (_.has(resources, type)) {
         Resource = resources[type];
         resource = new Resource(evt);

         // possible RequestType values: Create / Update / Delete
         return resource[`handle${evt.RequestType}`]()
            .catch(resource.sendError.bind(resource));
      }

      resource = new BaseResource(evt);

      return resource.sendError(new Error(`Unsupported resource type: ${type}`));
   },

};
