'use strict';

var _ = require('underscore'),
    Q = require('q'),
    AWS = require('aws-sdk'),
    kms = new AWS.KMS(),
    BaseResource = require('./BaseResource');

module.exports = BaseResource.extend({

   doCreate: function(props) {
      var params = _.pick(props, 'GranteePrincipal', 'KeyId', 'Operations', 'Constraints', 'GrantTokens', 'Name', 'RetiringPrincipal');

      return Q.ninvoke(kms, 'createGrant', params)
         .then(function(resp) {
            return { PhysicalResourceId: resp.GrantId, GrantToken: resp.GrantToken };
         });
   },

   doDelete: function(resourceID, props) {
      return Q.ninvoke(kms, 'retireGrant', { GrantId: resourceID, KeyId: props.KeyId })
         .catch(function(e) {
            // If the grant wasn't found, that means it may never have been created
            // (perhaps due to some error), and thus doesn't need to be deleted.
            if (e && e.code === 'NotFoundException') {
               return;
            }
            throw e;
         })
         .thenResolve({ PhysicalResourceId: resourceID });
   },

   doUpdate: function(resourceID, props) {
      // CloudFormation will detect that this update resulted in a new resource because
      // the physical ID changed (CF: PhysicalResourceId, KMS: GrantId), and it will issue
      // the delete command with the old resourceID.
      return this.doCreate(props);
   },

});
