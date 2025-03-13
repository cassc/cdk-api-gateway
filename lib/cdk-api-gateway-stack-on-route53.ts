import * as cdk from 'aws-cdk-lib'
import * as apigateway from 'aws-cdk-lib/aws-apigateway'
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import { Construct } from 'constructs'

export class CdkApiGatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    // Change this to your domain name
    const domainName = process.env.DOMAIN_NAME!
    const hostedZoneId = process.env.HOSTED_ZONE_ID // Get from Route 53

    if (!domainName || !hostedZoneId) {
      throw new Error('Please provide DOMAIN_NAME and HOSTED_ZONE_ID')
    }

    // Lookup Route 53 Hosted Zone
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(
      this,
      'HostedZone',
      {
        hostedZoneId: hostedZoneId, // Get from Route 53
        zoneName: domainName,
      }
    )

    // Backend Lambda function
    const backendLambda = new lambda.Function(this, 'BackendLambda', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          return { statusCode: 200, body: JSON.stringify({ message: "Hello from API" }) };
        };
      `),
    })

    // Authorization Lambda function
    const authLambda = new lambda.Function(this, 'AuthLambda', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
// output must comply with prefined format
     exports.handler = async (event) => {
       console.log("Received event:", JSON.stringify(event, null, 2));
       var headers = event.headers;

       const token = event.headers.authorization || event.headers.Authorization; // api-gateway converts this to lowercase
       if (token === "allow") {
         return {
          "principalId": "user", // todo change to real user id
          "policyDocument": {
            "Version": "2012-10-17",
            "Statement": [
              {
                "Action": "execute-api:Invoke",
                "Effect": "Allow",
                "Resource": event.methodArn
              }
            ]
          }
        }
       } else {
         throw new Error("Blocked by lambda authorizer");
       }
     };

      `),
    })

    // API Gateway
    const api = new apigateway.RestApi(this, 'ApiGateway', {
      deployOptions: {
        stageName: 'prod', // A stage is required, but we will map it to "/"
      },
    })

    backendLambda.addPermission('ApiGatewayInvokeBackend', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${api.restApiId}/*`,
    })

    authLambda.addPermission('ApiGatewayInvokeAuth', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${api.restApiId}/*`,
    })

    // Create an SSL certificate for API Gateway, this creates a certificate in the region of the stack,
    const apiGatewayCertificate = new certificatemanager.Certificate(
      this,
      'ApiCertificate',
      {
        domainName,
        validation:
          certificatemanager.CertificateValidation.fromDns(hostedZone),
      }
    )

    const domain = new apigateway.DomainName(this, 'ApiGatewayDomain', {
      domainName,
      certificate: apiGatewayCertificate, // Must be in the same region as API Gateway
    })

    new apigateway.BasePathMapping(this, 'BasePathMapping', {
      domainName: domain,
      restApi: api,
      stage: api.deploymentStage,
    })

    // Authorizer
    const authorizer = new apigateway.RequestAuthorizer(
      this,
      'LambdaAuthorizer',
      {
        handler: authLambda, // Lambda function handling authorization
        identitySources: [
          apigateway.IdentitySource.header('Authorization'),
          apigateway.IdentitySource.header('authorization'), // lower case if going through route 53
        ], // Extract token from "Authorization" header
        resultsCacheTtl: cdk.Duration.seconds(300), // Cache results for 5 minutes
      }
    )

    // API Resource
    const resource = api.root.addResource('check')
    resource.addMethod('GET', new apigateway.LambdaIntegration(backendLambda), {
      authorizationType: apigateway.AuthorizationType.CUSTOM,
      authorizer,
    })

    // Route 53 Record: Iff you use AWS to manage the DNS of your (sub)domain, cost 0.5 per month
    new route53.ARecord(this, 'ApiARecord', {
      zone: hostedZone,
      recordName: domainName,
      target: route53.RecordTarget.fromAlias(
        new targets.ApiGatewayDomain(domain)
      ),
    })
  }
}

if (process.env.CDK_DEFAULT_REGION && process.env.CDK_DEFAULT_ACCOUNT) {
  const app = new cdk.App()
  new CdkApiGatewayStack(app, 'CdkApiGatewayStack', {
    env: {
      region: process.env.CDK_DEFAULT_REGION,
      account: process.env.CDK_DEFAULT_ACCOUNT,
    },
  })
} else {
  throw new Error(
    'Please set env variables for CDK_DEFAULT_REGION and CDK_DEFAULT_ACCOUNT'
  )
}
