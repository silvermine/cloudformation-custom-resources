'use strict';

var expect = require('chai').expect,
    sinon = require('sinon'),
    rewire = require('rewire'),
    SESRuleSet = rewire('../src/SimpleEmailServiceRuleSetActivation');

describe('SimpleEmailServiceRuleSetActivation', function() {

   var sesStub, baseEvent;

   beforeEach(function() {
      sesStub = { send: sinon.stub() };
      SESRuleSet.__set__('ses', sesStub);

      baseEvent = {
         StackId: 'arn:aws:cloudformation:us-east-1:123456789:stack/my-stack/guid',
         RequestId: 'unique-id-1234',
         LogicalResourceId: 'MyRuleSetActivation',
         PhysicalResourceId: 'my-rule-set',
         ResponseURL: 'https://s3.amazonaws.com/bucket/key',
         ResourceProperties: {
            RuleSetName: 'my-rule-set',
         },
      };
   });

   afterEach(function() {
      sinon.restore();
   });

   describe('doCreate', function() {

      it('activates the rule set and returns the rule set name', function() {
         var resource = new SESRuleSet(baseEvent);

         sesStub.send.resolves({});

         return resource.doCreate(baseEvent.ResourceProperties).then(function(result) {
            expect(result.PhysicalResourceId).to.strictlyEqual('my-rule-set');
            expect(sesStub.send.calledOnce).to.strictlyEqual(true);
         });
      });

   });

   describe('doUpdate', function() {

      it('activates the new rule set', function() {
         var resource = new SESRuleSet(baseEvent);

         sesStub.send.resolves({});

         return resource.doUpdate('old-rule-set', baseEvent.ResourceProperties).then(function(result) {
            expect(result.PhysicalResourceId).to.strictlyEqual('my-rule-set');
            expect(sesStub.send.calledOnce).to.strictlyEqual(true);
         });
      });

   });

   describe('doDelete', function() {

      it('returns an empty object (base class default)', function() {
         var resource = new SESRuleSet(baseEvent);

         return resource.doDelete('my-rule-set', baseEvent.ResourceProperties).then(function(result) {
            expect(result).to.eql({});
         });
      });

   });

});
