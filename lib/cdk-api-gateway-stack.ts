import * as cdk from 'aws-cdk-lib'
import * as apigateway from 'aws-cdk-lib/aws-apigateway'
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { Construct } from 'constructs'

export class CdkApiGatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    // Change this to your domain name
    const domainName = process.env.DOMAIN_NAME

    if (!domainName || !process.env.API_GATEWAY_CERTIFICATE_ARN) {
      throw new Error(
        'Please provide a domain name in the DOMAIN_NAME environment variable'
      )
    }

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

    const apiGatewayCertificate =
      certificatemanager.Certificate.fromCertificateArn(
        this,
        'ApiGatewayCertificate',
        process.env.API_GATEWAY_CERTIFICATE_ARN // Created manually in the target region and validated by adding the CNAME record in CloudFlare
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
