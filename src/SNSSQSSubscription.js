'use strict';

var Q = require('q'),
    AWS = require('aws-sdk'),
    BaseResource = require('./BaseResource');

module.exports = BaseResource.extend({

   doCreate: function(props) {
      return this.createSubscription(props.TopicArn, props.QueueArn);
   },

   doDelete: function(resourceID) {
      if (resourceID.startsWith(`${this._event.LogicalResourceId}-`)) {
         console.log('no delete to handle - not a real subscription ARN');

         return Q.when({});
      }

      return this.deleteSubscription(resourceID);
   },

   doUpdate: function(resourceID, props) {
      // We simply create a new subscription. If SNS returns the SubscriptionArn of the
      // previous subscription (essentially handling the de-dupe for us), then
      // CloudFormation will be fine. If, on the other hand, SNS returns a new
      // SubscriptionArn, CloudFormation will see this update as a replacement, and will
      // then issue a delete command using the previous physical resource ID. (It appears
      // that SNS automatically does the de-duping, so this statement is primarily to
      // clarify that even if it did not - or that behavior changed in the future - we
      // should still be fine because of the CloudFormation behavior of deleting after an
      // update returns a new PhysicalResourceId). See
      // http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cfn-customresource.html
      return this.createSubscription(props.TopicArn, props.QueueArn);
   },

   createSubscription: function(topicARN, queueARN) {
      var sns = this._createSNS(topicARN);

      console.log('create for', JSON.stringify(this._event));

      return Q.ninvoke(sns, 'subscribe', { Protocol: 'sqs', TopicArn: topicARN, Endpoint: queueARN })
         .then(function(resp) {
            console.log('subscribe response:', JSON.stringify(resp));

            return { PhysicalResourceId: resp.SubscriptionArn, SubscriptionArn: resp.SubscriptionArn };
         });
   },

   deleteSubscription: function(resourceID) {
      var sns = this._createSNS(resourceID);

      console.log('delete for', JSON.stringify(this._event));

      return Q.ninvoke(sns, 'unsubscribe', { SubscriptionArn: resourceID })
         .then(function(resp) {
            console.log('unsubscribe response:', JSON.stringify(resp));

            return {};
         });
   },

   _createSNS: function(likeARN) {
      var parts = likeARN.split(':'),
          region = parts[3];

      console.log('creating SNS for region "%s" from ARN-like string "%s"', region, likeARN);

      return new AWS.SNS({ region: region });
   },

});
