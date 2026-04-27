'use strict';

var _ = require('underscore'),
    { SESClient, VerifyDomainIdentityCommand, DeleteIdentityCommand } = require('@aws-sdk/client-ses'),
    ses = new SESClient(),
    BaseResource = require('./BaseResource');

module.exports = BaseResource.extend({

   doCreate: async function(props) {
      var resp = await ses.send(new VerifyDomainIdentityCommand(_.pick(props, 'Domain')));

      return { PhysicalResourceId: props.Domain, VerificationToken: resp.VerificationToken };
   },

   doDelete: async function(resourceID) {
      await ses.send(new DeleteIdentityCommand({ Identity: resourceID }));

      return {};
   },

   doUpdate: async function(resourceID, props, oldProps) {
      await this.doDelete(oldProps.Domain);

      return this.doCreate(props);
   },

});
