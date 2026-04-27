'use strict';

var expect = require('chai').expect,
    sinon = require('sinon'),
    rewire = require('rewire'),
    SESVerification = rewire('../src/SimpleEmailServiceDomainVerification');

describe('SimpleEmailServiceDomainVerification', function() {

   var sesStub, baseEvent;

   beforeEach(function() {
      sesStub = { send: sinon.stub() };
      SESVerification.__set__('ses', sesStub);

      baseEvent = {
         StackId: 'arn:aws:cloudformation:us-east-1:123456789:stack/my-stack/guid',
         RequestId: 'unique-id-1234',
         LogicalResourceId: 'MyDomainVerification',
         PhysicalResourceId: 'example.com',
         ResponseURL: 'https://s3.amazonaws.com/bucket/key',
         ResourceProperties: {
            Domain: 'example.com',
         },
         OldResourceProperties: {
            Domain: 'old.example.com',
         },
      };
   });

   afterEach(function() {
      sinon.restore();
   });

   describe('doCreate', function() {

      it('verifies the domain and returns the verification token', function() {
         var resource = new SESVerification(baseEvent);

         sesStub.send.resolves({ VerificationToken: 'abc123token' });

         return resource.doCreate(baseEvent.ResourceProperties).then(function(result) {
            expect(result.PhysicalResourceId).to.strictlyEqual('example.com');
            expect(result.VerificationToken).to.strictlyEqual('abc123token');
            expect(sesStub.send.calledOnce).to.strictlyEqual(true);
         });
      });

   });

   describe('doDelete', function() {

      it('deletes the identity', function() {
         var resource = new SESVerification(baseEvent);

         sesStub.send.resolves({});

         return resource.doDelete('example.com').then(function(result) {
            expect(result).to.eql({});
            expect(sesStub.send.calledOnce).to.strictlyEqual(true);
         });
      });

   });

   describe('doUpdate', function() {

      it('deletes the old domain and creates the new one', function() {
         var resource = new SESVerification(baseEvent);

         sesStub.send.resolves({ VerificationToken: 'new-token' });

         return resource.doUpdate('old.example.com', baseEvent.ResourceProperties, baseEvent.OldResourceProperties)
            .then(function(result) {
               expect(result.PhysicalResourceId).to.strictlyEqual('example.com');
               expect(result.VerificationToken).to.strictlyEqual('new-token');
               // One call for delete, one for create
               expect(sesStub.send.calledTwice).to.strictlyEqual(true);
            });
      });

   });

});
