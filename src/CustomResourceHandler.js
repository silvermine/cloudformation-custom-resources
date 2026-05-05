'use strict';

const BaseResource = require('./BaseResource'),
      SimpleDynamoDBGlobalTable = require('./SimpleDynamoDBGlobalTable'),
      DynamoDBGlobalTable = require('./DynamoDBGlobalTable'),
      SimpleEmailServiceDomainVerification = require('./SimpleEmailServiceDomainVerification'),
      SimpleEmailServiceRuleSetActivation = require('./SimpleEmailServiceRuleSetActivation');

// SimpleDynamoDBGlobalTable is selected via the IsSimpleType flag below, so consumers
// continue to use the stable `Custom::DynamoDBGlobalTable` resource type.
const resources = {
   SimpleDynamoDBGlobalTable,
   DynamoDBGlobalTable,
   SimpleEmailServiceDomainVerification,
   SimpleEmailServiceRuleSetActivation,
};

// invoked by CloudFormation stack creates / updates / deletes
exports.handler = async (evt) => {
   const type = evt.ResourceType.replace(/^Custom::/, '');

   console.log('custom resource event: %j', evt);

   if (!Object.prototype.hasOwnProperty.call(resources, type)) {
      const resource = new BaseResource(evt);

      return resource.sendError(new Error(`Unsupported resource type: ${type}`));
   }

   let Resource = resources[type];

   console.log(`Type: "${type}"`);
   if (type === 'DynamoDBGlobalTable' && evt.ResourceProperties && evt.ResourceProperties.IsSimpleType) {
      console.log('Using simple version of DynamoDBGlobalTable');
      Resource = resources.SimpleDynamoDBGlobalTable;
   }

   const resource = new Resource(evt),
         method = `handle${evt.RequestType}`;

   try {
      return await resource[method]();
   } catch(err) {
      // handle{Create,Update,Delete} catch their own errors and respond, but guard here
      // in case any future override re-throws so CloudFormation always gets a response.
      return resource.sendError(err);
   }
};
