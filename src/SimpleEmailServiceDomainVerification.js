'use strict';

const _ = require('underscore'),
      BaseResource = require('./BaseResource');

const {
   SESClient,
   VerifyDomainIdentityCommand,
   DeleteIdentityCommand,
} = require('@aws-sdk/client-ses');

const ses = new SESClient({});

class SimpleEmailServiceDomainVerification extends BaseResource {

   async doCreate(props) {
      const resp = await ses.send(new VerifyDomainIdentityCommand(_.pick(props, 'Domain')));

      return { PhysicalResourceId: props.Domain, VerificationToken: resp.VerificationToken };
   }

   async doDelete(resourceID) {
      await ses.send(new DeleteIdentityCommand({ Identity: resourceID }));

      return { PhysicalResourceId: resourceID };
   }

   async doUpdate(resourceID, props, oldProps) {
      await this.doDelete(oldProps.Domain);

      return this.doCreate(props);
   }

}

module.exports = SimpleEmailServiceDomainVerification;
