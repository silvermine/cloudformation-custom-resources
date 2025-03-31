'use strict';

var _ = require('underscore'),
    Q = require('q'),
    handler = require('silvermine-lambda-utils/callPromiseFunctionIgnoreResolvedValueHandler'),
    BaseResource = require('./BaseResource'),
    resources;

resources = {
   KMSKeyGrant: require('./KMSKeyGrant'), // eslint-disable-line global-require
   SNSSQSSubscription: require('./SNSSQSSubscription'), // eslint-disable-line global-require
   // This resource will be named "SimpleDynamoDBGlobalTable" only in 1.0.0-rc3 for the
   // transition from the old DynamoDBGlobalTable resource to the newer, simpler one. See
   // the code below that helps with this transition. In 1.0.0-rc4 and subsequent
   // releases, the DynamoDBGlobalTable resource will be removed, this
   // SimpleDynamoDBGlobalTable will replace it, and the transition code below will be
   // deleted. Note that nobody should use the SimpleDynamoDBGlobalTable name directly
   // (e.g. in a `Custom::SimpleDynamoDBGlobalTable` type resource), but should use the
   // transition code so that the type stays stable as `Custom::DynamoDBGlobalTable`.
   SimpleDynamoDBGlobalTable: require('./SimpleDynamoDBGlobalTable'), // eslint-disable-line global-require
   DynamoDBGlobalTable: require('./DynamoDBGlobalTable'), // eslint-disable-line global-require
   SimpleEmailServiceDomainVerification: require('./SimpleEmailServiceDomainVerification'), // eslint-disable-line global-require
   SimpleEmailServiceRuleSetActivation: require('./SimpleEmailServiceRuleSetActivation'), // eslint-disable-line global-require
   APIGatewayDomainName: require('./APIGatewayDomainName'), // eslint-disable-line global-require
   ELBTargetGroup: require('./ELBTargetGroup'), // eslint-disable-line global-require
   ELBTargetGroupLambdaTarget: require('./ELBTargetGroupLambdaTarget'), // eslint-disable-line global-require
   ElasticSearchClusterSettings: require('./ElasticSearchClusterSettings'), // eslint-disable-line global-require
   ElasticSearchIndex: require('./ElasticSearchIndex'), // eslint-disable-line global-require
   ElasticSearchIndexAlias: require('./ElasticSearchIndexAlias'), // eslint-disable-line global-require
   ElasticSearchPackage: require('./ElasticSearchPackage'), // eslint-disable-line global-require
   OpenSearchRole: require('./OpenSearchRole'), // eslint-disable-line global-require
};

module.exports = {

   // invoked by CloudFormation stack creates / updates / deletes
   handler: function(evt, context, cb) {
      var type = evt.ResourceType.replace(/^Custom::/, ''),
          Resource, resource, fn;

      console.log('custom resource event: %j', evt);

      if (_.has(resources, type)) {
         Resource = resources[type];

         // This is only temporary for the 1.0.0-rc3 transition.
         console.log(`Type: "${type}"`);
         if (type === 'DynamoDBGlobalTable' && evt.ResourceProperties && evt.ResourceProperties.IsSimpleType) {
            console.log('Using simple version of DynamoDBGlobalTable');
            Resource = resources.SimpleDynamoDBGlobalTable;
         }

         resource = new Resource(evt);
         fn = function() {
            // possible RequestType values: Create / Update / Delete
            return Q.promised(resource[`handle${evt.RequestType}`].bind(resource))()
               .catch(resource.sendError.bind(resource));
         };
      } else {
         resource = new BaseResource(evt);
         fn = resource.sendError.bind(resource, new Error(`Unsupported resource type: ${type}`));
      }

      handler(fn, context, cb);
   },

};
