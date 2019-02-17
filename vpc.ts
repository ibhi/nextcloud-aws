import cloudform, { Fn, Refs, EC2, StringParameter, ResourceTag, Route53, NumberParameter, IAM, Value, Logs, ElasticLoadBalancingV2, ECS, SNS, RDS } from 'cloudform';

const USER_DATA: string = `#!/bin/bash -xe
export PATH=/usr/local/bin:$PATH
yum -y --security update
easy_install pip
pip install awscli

aws configure set default.region \${AWS::Region}

echo ECS_CLUSTER=\${ECSCluster} >> /etc/ecs/ecs.config

# https://docs.aws.amazon.com/AmazonECS/latest/developerguide/using_cloudwatch_logs.html

Content-Type: multipart/mixed; boundary="==BOUNDARY=="
MIME-Version: 1.0

--==BOUNDARY==
Content-Type: text/x-shellscript; charset="us-ascii"
#!/usr/bin/env bash
# Install awslogs and the jq JSON parser
yum install -y awslogs jq

# Inject the CloudWatch Logs configuration file contents
cat > /etc/awslogs/awslogs.conf <<- EOF
[general]
state_file = /var/lib/awslogs/agent-state        
 
[/var/log/dmesg]
file = /var/log/dmesg
log_group_name = /var/log/dmesg
log_stream_name = {cluster}/{container_instance_id}

[/var/log/messages]
file = /var/log/messages
log_group_name = /var/log/messages
log_stream_name = {cluster}/{container_instance_id}
datetime_format = %b %d %H:%M:%S

[/var/log/ecs/ecs-init.log]
file = /var/log/ecs/ecs-init.log
log_group_name = /var/log/ecs/ecs-init.log
log_stream_name = {cluster}/{container_instance_id}
datetime_format = %Y-%m-%dT%H:%M:%SZ

[/var/log/ecs/ecs-agent.log]
file = /var/log/ecs/ecs-agent.log.*
log_group_name = /var/log/ecs/ecs-agent.log
log_stream_name = {cluster}/{container_instance_id}
datetime_format = %Y-%m-%dT%H:%M:%SZ

[/var/log/ecs/audit.log]
file = /var/log/ecs/audit.log.*
log_group_name = /var/log/ecs/audit.log
log_stream_name = {cluster}/{container_instance_id}
datetime_format = %Y-%m-%dT%H:%M:%SZ

EOF

--==BOUNDARY==
Content-Type: text/x-shellscript; charset="us-ascii"
#!/usr/bin/env bash
# Write the awslogs bootstrap script to /usr/local/bin/bootstrap-awslogs.sh
cat > /usr/local/bin/bootstrap-awslogs.sh <<- 'EOF'
#!/usr/bin/env bash
exec 2>>/var/log/ecs/cloudwatch-logs-start.log
set -x

until curl -s http://localhost:51678/v1/metadata
do
	sleep 1	
done

# Set the region to send CloudWatch Logs data to (the region where the container instance is located)
cp /etc/awslogs/awscli.conf /etc/awslogs/awscli.conf.bak
region=$(curl -s 169.254.169.254/latest/dynamic/instance-identity/document | jq -r .region)
sed -i -e "s/region = .*/region = $region/g" /etc/awslogs/awscli.conf

# Grab the cluster and container instance ARN from instance metadata
cluster=$(curl -s http://localhost:51678/v1/metadata | jq -r '. | .Cluster')
container_instance_id=$(curl -s http://localhost:51678/v1/metadata | jq -r '. | .ContainerInstanceArn' | awk -F/ '{print $2}' )

# Replace the cluster name and container instance ID placeholders with the actual values
cp /etc/awslogs/awslogs.conf /etc/awslogs/awslogs.conf.bak
sed -i -e "s/{cluster}/$cluster/g" /etc/awslogs/awslogs.conf
sed -i -e "s/{container_instance_id}/$container_instance_id/g" /etc/awslogs/awslogs.conf
EOF

--==BOUNDARY==
Content-Type: text/x-shellscript; charset="us-ascii"
#!/usr/bin/env bash
# Write the bootstrap-awslogs systemd unit file to /etc/systemd/system/bootstrap-awslogs.service
cat > /etc/systemd/system/bootstrap-awslogs.service <<- EOF
[Unit]
Description=Bootstrap awslogs agent
Requires=ecs.service
After=ecs.service
Before=awslogsd.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/bootstrap-awslogs.sh

[Install]
WantedBy=awslogsd.service
EOF

--==BOUNDARY==
Content-Type: text/x-shellscript; charset="us-ascii"
#!/bin/sh
chmod +x /usr/local/bin/bootstrap-awslogs.sh
systemctl daemon-reload
systemctl enable bootstrap-awslogs.service
systemctl enable awslogsd.service
systemctl start awslogsd.service --no-block

--==BOUNDARY==--

cat <<EOF > /etc/init/spot-instance-termination-notice-handler.conf
description "Start spot instance termination handler monitoring script"
author "Amazon Web Services"
start on started ecs
script
echo \$\$ > /var/run/spot-instance-termination-notice-handler.pid
exec /usr/local/bin/spot-instance-termination-notice-handler.sh
end script
pre-start script
logger "[spot-instance-termination-notice-handler.sh]: spot instance termination
notice handler started"
end script
EOF
cat <<EOF > /usr/local/bin/spot-instance-termination-notice-handler.sh
#!/bin/bash
while sleep 5; do
if [ -z \$(curl -Isf http://169.254.169.254/latest/meta-data/spot/termination-time)];
then
/bin/false
else
logger "[spot-instance-termination-notice-handler.sh]: spot instance termination
notice detected"
STATUS=DRAINING
ECS_CLUSTER=\$(curl -s http://localhost:51678/v1/metadata | jq .Cluster | tr
-d \")
CONTAINER_INSTANCE=\$(curl -s http://localhost:51678/v1/metadata | jq .ContainerInstanceArn
| tr -d \")
logger "[spot-instance-termination-notice-handler.sh]: putting instance in state
\$STATUS"
logger "[spot-instance-termination-notice-handler.sh]: running: /usr/local/bin/aws
ecs update-container-instances-state --cluster \$ECS_CLUSTER --container-instances
\$CONTAINER_INSTANCE --status \$STATUS"
/usr/local/bin/aws ecs update-container-instances-state --cluster \$ECS_CLUSTER
--container-instances \$CONTAINER_INSTANCE --status \$STATUS
logger "[spot-instance-termination-notice-handler.sh]: running: \"/usr/local/bin/aws
sns publish --topic-arn \${SnsTopic} --message \"Spot instance termination notice
detected. Details: cluster: \$ECS_CLUSTER, container_instance: \$CONTAINER_INSTANCE.
Putting instance in state \$STATUS.\""
/usr/local/bin/aws sns publish --topic-arn \${SnsTopic} --message "Spot instance
termination notice detected. Details: cluster: \$ECS_CLUSTER, container_instance:
\$CONTAINER_INSTANCE. Putting instance in state \$STATUS."
logger "[spot-instance-termination-notice-handler.sh]: putting myself to sleep..."
sleep 120
fi
done
EOF
chmod +x /usr/local/bin/spot-instance-termination-notice-handler.sh
`;

export default cloudform({
    Description: 'AWS Cloudformation template for nextcloud with S3 bucket AWS using EC2 Spot',
    Mappings: {
        CidrMappings: {
            PublicSubnet1: {
                CIDR: '10.0.0.0/18'
            },
            PublicSubnet2: {
                CIDR: '10.0.64.0/18'
            },
            PrivateSubnet1: {
                CIDR: '10.0.128.0/18'
            },
            PrivateSubnet2: {
                CIDR: '10.0.192.0/18'
            },
            VPC: {
                CIDR: '10.0.0.0/16'
            }
        },
        // https://docs.aws.amazon.com/AmazonECS/latest/developerguide/retrieve-ecs-optimized_AMI.html
        // for region in $(aws ec2 describe-regions --query "Regions[].RegionName" --output text)
        // do
        // echo "${region}: {\n AMI: '$(aws ec2 describe-images --owners amazon --filters Name=name,Values=amzn2-ami-ecs-hvm-2.0.20190204-x86_64-ebs --query "reverse(sort_by(Images, &CreationDate))[0].ImageId" --output text --region $region)'\n},"
        // done
        Ubuntu: {
            'eu-north-1': {
                AMI: 'ami-092c0f6a6cc3638c4'
            },
            'ap-south-1': {
                AMI: 'ami-06016d6b78ec83843'
            },
            'eu-west-3': {
                AMI: 'ami-0ab92fbd5dc35efa5'
            },
            'eu-west-2': {
                AMI: 'ami-0bcc92a4e661446c1'
            },
            'eu-west-1': {
                AMI: 'ami-0885003261a52af1c'
            },
            'ap-northeast-2': {
                AMI: 'ami-0ae0c329bb532b6d0'
            },
            'ap-northeast-1': {
                AMI: 'ami-0ea322c77fc5ff655'
            },
            'sa-east-1': {
                AMI: 'ami-002111a63f9ad4724'
            },
            'ca-central-1': {
                AMI: 'ami-0df37f84fc18ba923'
            },
            'ap-southeast-1': {
                AMI: 'ami-060c7b75c31ac0a2a'
            },
            'ap-southeast-2': {
                AMI: 'ami-046f9a4716a10bfa3'
            },
            'eu-central-1': {
                AMI: 'ami-08ab7d08250c248ce'
            },
            'us-east-1': {
                AMI: 'ami-032564940f9afd5c0'
            },
            'us-east-2': {
                AMI: 'ami-03757cbb3bae03fe7'
            },
            'us-west-1': {
                AMI: 'ami-030dcc999f03d168b'
            },
            'us-west-2': {
                AMI: 'ami-0291b991e70d83d33'
            }
        }
    },
    Parameters: {
        SourceCidr: new StringParameter({
            Description: 'Optional - CIDR/IP range for instance ssh access - defaults to 0.0.0.0/0',
            Default: '0.0.0.0/0'
        }),
        DomainName: new StringParameter({
            Description: 'Enter your custom domain name',
            Default: 'ibhi.cf'
        }),
        KeyName: {
            Description: 'Description: Name of an existing EC2 KeyPair to enable SSH access to the EC2 Instances',
            Type: 'AWS::EC2::KeyPair::KeyName'
        },
        SpotPrice: new NumberParameter({
            Description: 'Spot Instance Bid Price',
            Default: 0.1
        }),
        SpotfleetTargetCapacity: new NumberParameter({
            Description: 'Spot Fleet Target Instance Capacity',
            Default: 2
        }),
        NextCloudSecrets: new StringParameter({
            Description: 'Enter ARN for nextcloud secrets from AWS Secrets Manager'
        }),
        DatabaseName: new StringParameter({
            Description: 'Name of the RDS database',
            Default: 'nextcloud'
        }),
        DatabaseUsername: new StringParameter({
            Description: 'User Name for the RDS database',
            Default: 'nextcloud'
        }),
        DatabasePassword: new StringParameter({
            Description: 'Password for the RDS database',
            Default: 'nextcloud'
        })
    },
    Outputs: {
        VPC: {
            Description: 'PMS VPC Id',
            Value: Fn.Ref('VPC'),
            Export: {
                Name: Fn.Sub('${AWS::StackName}-VPC', {})
            }
        },
        PublicSubnet1: {
            Description: 'Public Subnet 1 Id',
            Value: Fn.Ref('PublicSubnet1'),
            Export: {
                Name: Fn.Sub('${AWS::StackName}-PublicSubnet1', {})
            }
        },
        PublicSubnet2: {
            Description: 'Public Subnet 2 Id',
            Value: Fn.Ref('PublicSubnet2'),
            Export: {
                Name: Fn.Sub('${AWS::StackName}-PublicSubnet2', {})
            }
        },
        ApplicationLoadBalancerUrl: {
            Description: 'The URL of the Application Load Balancer',
            Value: Fn.Join('', ['http://', Fn.GetAtt('ApplicationLoadBalancer', 'DNSName')] )
        }
    },
    Resources: {
        VPC: new EC2.VPC({
            CidrBlock: Fn.FindInMap('CidrMappings', 'VPC', 'CIDR'),
            EnableDnsHostnames: true,
            EnableDnsSupport: true,
            Tags: [
                new ResourceTag('Name', 'VPC for Personal Cloud Server on AWS')
            ]
        }),

        InternetGateway: new EC2.InternetGateway().dependsOn('VPC'),

        AttachGateway: new EC2.VPCGatewayAttachment({
            InternetGatewayId: Fn.Ref('InternetGateway'),
            VpcId: Fn.Ref('VPC')
        }).dependsOn(['VPC', 'InternetGateway']),

        // Public Subnets
        PublicRouteTable: new EC2.RouteTable({
            VpcId: Fn.Ref('VPC'),
            Tags: [
                new ResourceTag('Name', 'Public Route Table')
            ]
        }).dependsOn(['VPC', 'AttachGateway']),

        PublicRoute: new EC2.Route({
            DestinationCidrBlock: '0.0.0.0/0',
            GatewayId: Fn.Ref('InternetGateway'),
            RouteTableId: Fn.Ref('PublicRouteTable')
        }).dependsOn(['InternetGateway', 'PublicRouteTable']),

        PublicSubnet1: new EC2.Subnet({
            AvailabilityZone: Fn.Select(0, Fn.GetAZs(Refs.Region)),
            CidrBlock: Fn.FindInMap('CidrMappings', 'PublicSubnet1', 'CIDR'),
            VpcId: Fn.Ref('VPC'),
            MapPublicIpOnLaunch: true,
            Tags: [
                new ResourceTag('Name', 'Public Subnet 1')
            ]
        }).dependsOn(['VPC']),

        PublicSubnet1RouteTableAssociation: new EC2.SubnetRouteTableAssociation({
            RouteTableId: Fn.Ref('PublicRouteTable'),
            SubnetId: Fn.Ref('PublicSubnet1')
        }).dependsOn(['PublicRouteTable', 'PublicSubnet1']),

        PublicSubnet2: new EC2.Subnet({
            AvailabilityZone: Fn.Select(1, Fn.GetAZs(Refs.Region)),
            CidrBlock: Fn.FindInMap('CidrMappings', 'PublicSubnet2', 'CIDR'),
            VpcId: Fn.Ref('VPC'),
            MapPublicIpOnLaunch: true,
            Tags: [
                new ResourceTag('Name', 'Public Subnet 2')
            ]
        }).dependsOn('VPC'),

        PublicSubnet2RouteTableAssociation: new EC2.SubnetRouteTableAssociation({
            RouteTableId: Fn.Ref('PublicRouteTable'),
            SubnetId: Fn.Ref('PublicSubnet2')
        }).dependsOn(['PublicRouteTable', 'PublicSubnet2']),

        // Private Subnets
        PrivateRouteTable: new EC2.RouteTable({
            VpcId: Fn.Ref('VPC'),
            Tags: [
                new ResourceTag('Name', 'Private Route Table')
            ]
        }).dependsOn(['VPC']),

        PrivateSubnet1: new EC2.Subnet({
            AvailabilityZone: Fn.Select(0, Fn.GetAZs(Refs.Region)),
            CidrBlock: Fn.FindInMap('CidrMappings', 'PrivateSubnet1', 'CIDR'),
            VpcId: Fn.Ref('VPC'),
            MapPublicIpOnLaunch: false,
            Tags: [
                new ResourceTag('Name', 'Private Subnet 1')
            ]
        }).dependsOn(['VPC']),

        PrivateSubnet1RouteTableAssociation: new EC2.SubnetRouteTableAssociation({
            RouteTableId: Fn.Ref('PrivateRouteTable'),
            SubnetId: Fn.Ref('PrivateSubnet1')
        }).dependsOn(['PrivateRouteTable', 'PrivateSubnet1']),

        PrivateSubnet2: new EC2.Subnet({
            AvailabilityZone: Fn.Select(1, Fn.GetAZs(Refs.Region)),
            CidrBlock: Fn.FindInMap('CidrMappings', 'PrivateSubnet2', 'CIDR'),
            VpcId: Fn.Ref('VPC'),
            MapPublicIpOnLaunch: false,
            Tags: [
                new ResourceTag('Name', 'Private Subnet 2')
            ]
        }).dependsOn(['VPC']),

        PrivateSubnet2RouteTableAssociation: new EC2.SubnetRouteTableAssociation({
            RouteTableId: Fn.Ref('PrivateRouteTable'),
            SubnetId: Fn.Ref('PrivateSubnet2')
        }).dependsOn(['PrivateRouteTable', 'PrivateSubnet2']),

        // End of VPC

        // Start of Application Load Balancer
        ApplicationLoadBalancerSecurityGroup: new EC2.SecurityGroup({
            GroupDescription: 'Application Load Balancer Security Group',
            SecurityGroupIngress: [
                new EC2.SecurityGroup.Ingress({
                    CidrIp: '0.0.0.0/0',
                    FromPort: 80,
                    ToPort: 80,
                    IpProtocol: 'tcp'
                }),
                new EC2.SecurityGroup.Ingress({
                    CidrIp: '0.0.0.0/0',
                    FromPort: 443,
                    ToPort: 443,
                    IpProtocol: 'tcp'
                })
            ],
            VpcId: Fn.Ref('VPC')
        }),

        ApplicationLoadBalancer: new ElasticLoadBalancingV2.LoadBalancer({
            LoadBalancerAttributes: [new ElasticLoadBalancingV2.LoadBalancer.LoadBalancerAttribute({
                Key: 'idle_timeout.timeout_seconds',
                Value: '30'
            })],
            Scheme: 'internet-facing',
            SecurityGroups: [Fn.Ref('ApplicationLoadBalancerSecurityGroup')],
            Subnets: [
                Fn.Ref('PublicSubnet1'),
                Fn.Ref('PublicSubnet2')
            ],
            Tags: [
                new ResourceTag('Name', 'Application Load Balancer')
            ],
            Type: 'application'
        }).dependsOn('ApplicationLoadBalancerSecurityGroup'),

        ApplicationLoadBalancerTargetGroup: new ElasticLoadBalancingV2.TargetGroup({
            HealthCheckIntervalSeconds: 30,
            HealthCheckPath: '/',
            HealthCheckTimeoutSeconds: 5,
            HealthyThresholdCount: 2,
            UnhealthyThresholdCount: 10,
            Port: 80,
            Protocol: 'HTTP',
            Matcher: {
                HttpCode: '200-499'
            },
            VpcId: Fn.Ref('VPC'),
            TargetGroupAttributes: [
                new ElasticLoadBalancingV2.TargetGroup.TargetGroupAttribute({
                    Key: 'stickiness.enabled',
                    Value: 'true'
                })
            ],
        }).dependsOn('VPC'),

        ApplicationLoadBalancerListener: new ElasticLoadBalancingV2.Listener({
            DefaultActions: [
                new ElasticLoadBalancingV2.Listener.Action({
                    Type: 'forward',
                    TargetGroupArn: Fn.Ref('ApplicationLoadBalancerTargetGroup')
                })
            ],
            LoadBalancerArn: Fn.Ref('ApplicationLoadBalancer'),
            Port: 80,
            Protocol: 'HTTP'
        }).dependsOn(['ApplicationLoadBalancerTargetGroup', 'ApplicationLoadBalancer']),

        // Start of cloud watch logs group
        CloudWatchLogsGroup: new Logs.LogGroup({
            RetentionInDays: 7
        }),
        // End of cloud watch logs group

        // Start of spot fleet

        SecurityGroup: new EC2.SecurityGroup({
            GroupDescription: 'Spot fleet instance security group',
            SecurityGroupIngress: [
                // Todo: Remove ssh access
                new EC2.SecurityGroup.Ingress({
                    CidrIp: Fn.Ref('SourceCidr'),
                    FromPort: 22,
                    ToPort: 22,
                    IpProtocol: 'tcp'
                }),
            ],
            VpcId: Fn.Ref('VPC')
        }),

        SecurityGroupIngressFromPublicALB: new EC2.SecurityGroupIngress({
            FromPort: 31000,
            ToPort: 61000,
            GroupId: Fn.GetAtt('SecurityGroup', 'GroupId'), 
            IpProtocol: '-1',
            SourceSecurityGroupId: Fn.GetAtt('ApplicationLoadBalancerSecurityGroup', 'GroupId')
        }).dependsOn(['SecurityGroup', 'ApplicationLoadBalancerSecurityGroup']),

        SecurityGroupIngressFromSelf: new EC2.SecurityGroupIngress({
            GroupId: Fn.GetAtt('SecurityGroup', 'GroupId'), 
            IpProtocol: '-1',
            SourceSecurityGroupId: Fn.Ref('SecurityGroup')
        }).dependsOn(['SecurityGroup']),

        SpotFleetRole: new IAM.Role({
            AssumeRolePolicyDocument: {
                Statement: [{
                    Effect: 'Allow',
                    Principal: {
                        Service: ['spotfleet.amazonaws.com']
                    },
                    Action: ['sts:AssumeRole']
                }],
                Version: '2012-10-17'
            },
            ManagedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AmazonEC2SpotFleetTaggingRole'],
            Path: '/'
        }),

        SpotFleetInstanceRole: createSpotFleetInstanceRole(),

        SpotFleetInstanceProfile: new IAM.InstanceProfile({
            Path: '/',
            Roles: [Fn.Ref('SpotFleetInstanceRole')]
        }).dependsOn('SpotFleetInstanceRole'),

        SpotFleet: new EC2.SpotFleet({
            SpotFleetRequestConfigData: new EC2.SpotFleet.SpotFleetRequestConfigData({
                AllocationStrategy: 'diversified',
                Type: 'maintain',
                IamFleetRole: Fn.GetAtt('SpotFleetRole', 'Arn'),
                SpotPrice: Fn.Ref('SpotPrice'),
                TargetCapacity: Fn.Ref('SpotfleetTargetCapacity'),
                TerminateInstancesWithExpiration: true,
                // InstanceInterruptionBehavior: 'stop',  default is terminate
                LaunchSpecifications: [
                    createLaunchSpecification('c5.large'),
                    createLaunchSpecification('m5.large')
                ]
            })
        }).dependsOn(['SpotFleetRole']),

        // End of Spot Fleet

        // Start of Aurora Serverless cluster

        DBSubnetGroup: new RDS.DBSubnetGroup({
            DBSubnetGroupName: 'nextcloud_db_subnet_group',
            DBSubnetGroupDescription: 'nextcloud db subnet group',
            SubnetIds: [Fn.Ref('PrivateSubnet1'), Fn.Ref('PrivateSubnet2')]
        }).dependsOn([
            'PrivateSubnet1',
            'PrivateSubnet2'
        ]),

        DBSecurityGroup: new EC2.SecurityGroup({
            GroupDescription: 'Spot fleet instance security group',
            SecurityGroupIngress: [
                new EC2.SecurityGroup.Ingress({
                    FromPort: 3306,
                    ToPort: 3306,
                    IpProtocol: 'tcp',
                    SourceSecurityGroupId: Fn.Ref('SecurityGroup')
                }),
            ],
            VpcId: Fn.Ref('VPC')
        }).dependsOn([
            'VPC',
            'SecurityGroup'
        ]),

        DBCluster: new RDS.DBCluster({
            Engine: 'aurora',
            EngineMode: 'serverless',
            EngineVersion: '5.6',
            DatabaseName: Fn.Ref('DatabaseName'),
            MasterUsername: Fn.Ref('DatabaseUsername'),
            MasterUserPassword: Fn.Ref('DatabasePassword'),
            DBClusterIdentifier: Refs.StackName,
            DBSubnetGroupName: Fn.Ref('DBSubnetGroup'),
            VpcSecurityGroupIds: [Fn.Ref('DBSecurityGroup')],
            BackupRetentionPeriod: 1
        }).dependsOn([
            'DBSubnetGroup',
            'DBSecurityGroup'
        ]),

        // End of Aurora Serverless cluster

        // Start of ECS

        ECSCluster: new ECS.Cluster({
            ClusterName: 'nextcloud'
        }),

        ECSServiceRole: new IAM.Role({
            AssumeRolePolicyDocument: {
                Statement: [{
                    Effect: 'Allow',
                    Principal: {
                        Service: ['ecs.amazonaws.com']
                    },
                    Action: ['sts:AssumeRole']
                }],
                Version: '2012-10-17'
            },
            ManagedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceRole'],
            Path: '/'
        }),

        ECSTaskDefinitionRole: new IAM.Role({
            AssumeRolePolicyDocument: {
                Statement: [{
                    Effect: 'Allow',
                    Principal: {
                        Service: ['ecs-tasks.amazonaws.com']
                    },
                    Action: ['sts:AssumeRole']
                }],
                Version: '2012-10-17'
            },
            ManagedPolicyArns: [
                'arn:aws:iam::aws:policy/AmazonEC2ReadOnlyAccess',
                'arn:aws:iam::aws:policy/service-role/AmazonEC2SpotFleetAutoscaleRole'
            ],
            Path: '/',
            Policies: [
                {
                    PolicyDocument: {
                        Version: '2012-10-17',
                        Statement: [
                            {
                                Effect: 'Allow',
                                Action: [
                                    'secretsmanager:GetSecretValue'
                                ],
                                Resource: 'arn:aws:secretsmanager:ap-south-1:782677160809:secret:prod/app/nextcloud-secrets-J3EI90'
                            }
                        ]
                    },
                    PolicyName: 'GetSecretFromSecretManager'
                },
            ]
        }),

        ECSTaskDefinition: new ECS.TaskDefinition({
            TaskRoleArn: Fn.Ref('ECSTaskDefinitionRole'),
            ContainerDefinitions: [
                new ECS.TaskDefinition.ContainerDefinition({
                    Image: 'nextcloud:latest',
                    Name: 'nextcloud',
                    PortMappings: [
                        new ECS.TaskDefinition.PortMapping({
                            ContainerPort: 80,
                            HostPort: 0,
                            Protocol: 'tcp'
                        })
                    ],
                    Memory: 1024,
                    Environment: [
                        // {
                        //     Name: 'NEXTCLOUD_ADMIN_USER',
                        //     Value: 'nextcloud'
                        // },
                        // {
                        //     Name: 'NEXTCLOUD_ADMIN_PASSWORD',
                        //     Value: 'nextcloud'
                        // },
                        {
                            Name: 'MYSQL_DATABASE',
                            Value: Fn.Ref('DatabaseName')
                        },
                        {
                            Name: 'MYSQL_USER',
                            Value: Fn.Ref('DatabaseUsername')
                        },
                        {
                            Name: 'MYSQL_PASSWORD',
                            Value: Fn.Ref('DatabasePassword')
                        },
                        {
                            Name: 'MYSQL_HOST',
                            Value: Fn.Join(':', [Fn.GetAtt('DBCluster', 'Endpoint.Address'), Fn.GetAtt('DBCluster', 'Endpoint.Port')])
                        }
                    ],
                    LogConfiguration: new ECS.TaskDefinition.LogConfiguration({
                        LogDriver: 'awslogs',
                        Options: {
                            'awslogs-group': Fn.Ref('CloudWatchLogsGroup'),
                            'awslogs-region': Refs.Region
                        }
                    })
                }),
            ]
        }).dependsOn([
            'CloudWatchLogsGroup',
            'ECSTaskDefinitionRole',
            'DBCluster'
        ]),

        ECSService: new ECS.Service({
            TaskDefinition: Fn.Ref('ECSTaskDefinition'),
            Cluster: Fn.Ref('ECSCluster'),
            DesiredCount: 2,
            LoadBalancers: [
                new ECS.Service.LoadBalancer({
                    ContainerName: 'nextcloud',
                    ContainerPort: 80,
                    TargetGroupArn: Fn.Ref('ApplicationLoadBalancerTargetGroup')
                })
            ],
            Role: Fn.Ref('ECSServiceRole')
        }).dependsOn([
            'ECSCluster',
            'ECSServiceRole',
            'ECSTaskDefinition',
            'ApplicationLoadBalancer',
            'ApplicationLoadBalancerTargetGroup',
            'ApplicationLoadBalancerListener',
        ]),

        // End of ECS

        SnsTopic: new SNS.Topic()

    }

});

function createLaunchSpecification(instanceType: Value<string>) {
    // var allocationId = Fn.GetAtt('ElasticIp', 'AllocationId');
    var publicSubnet1Id = Fn.Ref('PublicSubnet1');
    var publicSubnet2Id = Fn.Ref('PublicSubnet2');
    var securityGroupId = Fn.Ref('SecurityGroup');

    return new EC2.SpotFleet.SpotFleetLaunchSpecification({
        IamInstanceProfile: new EC2.SpotFleet.IamInstanceProfileSpecification({
            Arn: Fn.GetAtt('SpotFleetInstanceProfile', 'Arn')
        }),
        ImageId: Fn.FindInMap('Ubuntu', Refs.Region, 'AMI'),
        InstanceType: instanceType,
        KeyName: Fn.Ref('KeyName'),
        Monitoring: new EC2.SpotFleet.SpotFleetMonitoring({
            Enabled: true
        }),
        SecurityGroups: [new EC2.SpotFleet.GroupIdentifier({ GroupId: securityGroupId })],
        SubnetId: Fn.Join(',', [publicSubnet1Id, publicSubnet2Id]),
        BlockDeviceMappings: [
            new EC2.SpotFleet.BlockDeviceMapping({
                DeviceName: '/dev/sdk',
                Ebs: new EC2.SpotFleet.EbsBlockDevice({
                    VolumeSize: 40,
                    VolumeType: 'gp2',
                    DeleteOnTermination: true
                })
            })
        ],
        UserData: Fn.Base64(Fn.Sub(
            USER_DATA,
            {
                'LOGS': '/var/log/rclone',
            }
        ))
    })
}

function createSpotFleetInstanceRole() {
    return {
        Properties: {
            AssumeRolePolicyDocument: {
                'Statement': [{
                    Effect: 'Allow',
                    Principal: {
                        Service: ['ec2.amazonaws.com']
                    },
                    Action: ['sts:AssumeRole']
                }],
                Version: '2012-10-17'
            },
            ManagedPolicyArns: [
                'arn:aws:iam::aws:policy/service-role/AmazonEC2SpotFleetTaggingRole',
                'arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role'
            ],
            Path: '/',
            Policies: [
                {
                    PolicyDocument: {
                        Version: '2012-10-17',
                        Statement: [
                            {
                                Effect: 'Allow',
                                Action: [
                                    'ecs:CreateCluster',
                                    'ecs:DeregisterContainerInstance',
                                    'ecs:DiscoverPollEndpoint',
                                    'ecs:Poll',
                                    'ecs:RegisterContainerInstance',
                                    'ecs:StartTelemetrySession',
                                    'ecs:Submit*',
                                    'ecs:UpdateContainerInstancesState'
                                ],
                                Resource: '*'
                            }
                        ]
                    },
                    PolicyName: 'EcsUpdateContainerInstancesStatePolicy'
                },
                {
                    PolicyDocument: {
                        Version: '2012-10-17',
                        Statement: [{
                            Effect: 'Allow',
                            Action: [
                                "logs:CreateLogGroup",
                                "logs:CreateLogStream",
                                "logs:PutLogEvents",
                                "logs:DescribeLogStreams"
                            ],
                            Resource: ['arn:aws:logs:*:*:*']
                        }]
                    },
                    PolicyName: 'CloudWatchLogsPolicy'
                },
                // Todo: Move the below policy to task level permissions
                // {
                //     PolicyDocument: {
                //         Version: '2012-10-17',
                //         Statement: [
                //             {
                //                 Effect: 'Allow',
                //                 Action: 'secretsmanager:GetSecretValue',
                //                 Resource: Fn.Ref('NextCloudSecrets')
                //             }
                //         ]
                //     },
                //     PolicyName: 'SecretsManagerPolicy'
                // }
            ]
        },
        Type: 'AWS::IAM::Role'

    }
}
