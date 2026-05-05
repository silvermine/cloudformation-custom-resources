'use strict';

const _ = require('underscore'),
      { SESClient, SetActiveReceiptRuleSetCommand } = require('@aws-sdk/client-ses'),
      BaseResource = require('./BaseResource');

const ses = new SESClient({});

class SimpleEmailServiceRuleSetActivation extends BaseResource {

   async doCreate(props) {
      await ses.send(new SetActiveReceiptRuleSetCommand(_.pick(props, 'RuleSetName')));

      return { PhysicalResourceId: props.RuleSetName };
   }

   async doUpdate(resourceID, props) {
      return this.doCreate(props);
   }

}

module.exports = SimpleEmailServiceRuleSetActivation;
