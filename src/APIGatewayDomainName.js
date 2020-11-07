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

   doUpdate: function(resourceID, props, oldProps) {
      const cloneOfNewProps = JSON.parse(JSON.stringify(props)),
            cloneOfOldProps = JSON.parse(JSON.stringify(oldProps));

      // Remove the properties that *can* be updated (there's probably more)
      delete cloneOfNewProps.regionalCertificateArn;
      delete cloneOfOldProps.regionalCertificateArn;

      // Then check to see if any of the properties that remain (i.e. those that cannot be
      // updated) were changed
      if (!_.isEqual(cloneOfNewProps, cloneOfOldProps)) {
         // Log the old vs new props rather than putting the data in the error message as
         // the response can only be 4,096 bytes long. See:
         // https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cloudformation-limits.html
         console.log(
            `ERROR Not updating ${resourceID} as one or more of the changed fields does not support updates`
            + ` Old: ${JSON.stringify(oldProps)} New: ${JSON.stringify(props)}`
         );
         throw new Error(`One or more of the changed fields does not support updates (${resourceID})`);
      }

      const patchOperations = [];

      // eslint-disable-next-line max-len
      if (props.regionalCertificateArn && oldProps.regionalCertificateArn && props.regionalCertificateArn !== oldProps.regionalCertificateArn) {
         patchOperations.push({
            op: 'replace',
            path: '/regionalCertificateArn',
            value: props.regionalCertificateArn,
         });
      }

      if (_.isEmpty(patchOperations)) {
         // Log the old vs new props rather than putting the data in the error message as
         // the response can only be 4,096 bytes long. See:
         // https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cloudformation-limits.html
         console.log(
            `ERROR Not performing any patch operations on ${resourceID} as one or more of the changed fields does not support updates`
            + ` Old: ${JSON.stringify(oldProps)} New: ${JSON.stringify(props)}`
         );
         throw new Error(`One or more of the changed fields does not support updates (${resourceID})`);
      }

      return Q.ninvoke(apigw, 'updateDomainName', { domainName: resourceID, patchOperations })
         .then(function(resp) {
            return { PhysicalResourceId: resp.domainName, regionalDomainName: resp.regionalDomainName };
         });
   },

});
