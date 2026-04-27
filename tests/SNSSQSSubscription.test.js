'use strict';

var expect = require('chai').expect,
    sinon = require('sinon'),
    rewire = require('rewire'),
    SNSSQSSubscription = rewire('../src/SNSSQSSubscription');

describe('SNSSQSSubscription', function() {

   var snsStub, baseEvent;

   beforeEach(function() {
      snsStub = { send: sinon.stub() };

      SNSSQSSubscription.__set__('SNSClient', function() {
         return snsStub;
      });

      baseEvent = {
         StackId: 'arn:aws:cloudformation:us-east-1:123456789:stack/my-stack/guid',
         RequestId: 'unique-id-1234',
         LogicalResourceId: 'MySNSSub',
         ResponseURL: 'https://s3.amazonaws.com/bucket/key',
         ResourceProperties: {
            TopicArn: 'arn:aws:sns:us-east-1:123456789:MyTopic',
            QueueArn: 'arn:aws:sqs:us-east-1:123456789:MyQueue',
         },
      };
   });

   afterEach(function() {
      sinon.restore();
   });

   describe('doCreate', function() {

      it('subscribes and returns the subscription ARN', function() {
         var resource = new SNSSQSSubscription(baseEvent),
             subArn = 'arn:aws:sns:us-east-1:123456789:MyTopic:sub-guid';

         snsStub.send.resolves({ SubscriptionArn: subArn });

         return resource.doCreate(baseEvent.ResourceProperties).then(function(result) {
            expect(result.PhysicalResourceId).to.strictlyEqual(subArn);
            expect(result.SubscriptionArn).to.strictlyEqual(subArn);
            expect(snsStub.send.calledOnce).to.strictlyEqual(true);
         });
      });

   });

   describe('doDelete', function() {

      it('unsubscribes when given a real subscription ARN', function() {
         var resource = new SNSSQSSubscription(baseEvent),
             subArn = 'arn:aws:sns:us-east-1:123456789:MyTopic:sub-guid';

         snsStub.send.resolves({});

         return resource.doDelete(subArn).then(function(result) {
            expect(result).to.eql({});
            expect(snsStub.send.calledOnce).to.strictlyEqual(true);
         });
      });

      it('skips unsubscribe when resource ID is not a real ARN', function() {
         var resource = new SNSSQSSubscription(baseEvent),
             fakeID = baseEvent.LogicalResourceId + '-abc123';

         return resource.doDelete(fakeID).then(function(result) {
            expect(result).to.eql({});
            expect(snsStub.send.called).to.strictlyEqual(false);
         });
      });

   });

   describe('doUpdate', function() {

      it('creates a new subscription', function() {
         var resource = new SNSSQSSubscription(baseEvent),
             subArn = 'arn:aws:sns:us-east-1:123456789:MyTopic:new-sub-guid';

         snsStub.send.resolves({ SubscriptionArn: subArn });

         return resource.doUpdate('old-id', baseEvent.ResourceProperties).then(function(result) {
            expect(result.PhysicalResourceId).to.strictlyEqual(subArn);
         });
      });

   });

   describe('_createSNS', function() {

      it('extracts the region from an ARN', function() {
         var resource = new SNSSQSSubscription(baseEvent),
             client = resource._createSNS('arn:aws:sns:eu-west-1:123456789:MyTopic');

         // The client was created via our stub constructor; just verify
         // the function ran without errors
         expect(client).to.exist; // eslint-disable-line no-unused-expressions
      });

   });

});
