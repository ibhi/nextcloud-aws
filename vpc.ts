import cloudform, { Fn, Refs, EC2, StringParameter, ResourceTag, Route53, NumberParameter, IAM, Value, Logs } from 'cloudform';


const USER_DATA: string = `#!/bin/bash -xe
apt-get update
apt-get upgrade -y
apt-get install \
    apt-transport-https \
    ca-certificates \
    curl \
    software-properties-common -y
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | apt-key add -
add-apt-repository \
    "deb [arch=amd64] https://download.docker.com/linux/ubuntu \
    $(lsb_release -cs) \
    stable"
apt-get update
apt-get install docker-ce -y
curl -L "https://github.com/docker/compose/releases/download/1.23.2/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose

# Install nodejs
curl -sL https://deb.nodesource.com/setup_8.x | sudo -E bash -
sudo apt-get install -y nodejs

# Associate Elastic Ip to this spot instance
export EC2_INSTANCE_ID="\`wget -q -O - http://169.254.169.254/latest/meta-data/instance-id || die \"wget instance-id has failed: $?\"\`"
export ALLOCATION_ID=\${ElasticIp.AllocationId}

# Wait for the Elastic IP association to complete
sleep 15s

# Setup logs
cat <<EOF > /tmp/awslogs.conf
[general]
state_file = /var/awslogs/state/agent-state

[/var/log/syslog]
file = /var/log/syslog
log_group_name = \${CloudWatchLogsGroup}
log_stream_name = pms/var/log/syslog
datetime_format = %b %d %H:%M:%S
initial_position = start_of_file

[/var/log/docker]
file = /var/log/docker
log_group_name = \${CloudWatchLogsGroup}
log_stream_name = pms/var/log/docker
datetime_format = %Y-%m-%dT%H:%M:%S.%f
initial_position = start_of_file

[/var/log/cloud-init-output]
file = /var/log/cloud-init-output.log
log_group_name = \${CloudWatchLogsGroup}
log_stream_name = pms/var/log/cloud-init-output
datetime_format = %Y-%m-%dT%H:%M:%S.%f
initial_position = start_of_file

EOF

cd /tmp && curl -sO https://s3.amazonaws.com/aws-cloudwatch/downloads/latest/awslogs-agent-setup.py
python /tmp/awslogs-agent-setup.py -n -r \${AWS::Region} -c /tmp/awslogs.conf

cd /tmp
git clone https://github.com/ibhi/nextcloud-aws.git
cd nextcloud-aws
chmod 600 acme.json
npm install
node elastic-ip.js

# Docker compose
docker network create web
docker-compose up
`;

export default cloudform({
    Description: 'AWS Cloudformation template for nextcloud with S3 bucket AWS using EC2 Spot',
    Mappings: {
        CidrMappings: {
            PublicSubnet1: {
                CIDR: '10.0.1.0/24'
            },
            PublicSubnet2: {
                CIDR: '10.0.2.0/24'
            },
            VPC: {
                CIDR: '10.0.0.0/16'
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
        HostedZone: {
            Description: '',
            Value: Fn.Ref('HostedZone'),
            Export: {
                Name: Fn.Sub('${AWS::StackName}-HostedZone', {})
            }
        },
        SecurityGroup: {
            Description: '',
            Value: Fn.GetAtt('SecurityGroup', 'GroupId'),
            Export: {
                Name: Fn.Sub('${AWS::StackName}-SecurityGroup', {})
            }
        }
    },
    Resources: {
        VPC: new EC2.VPC({
            CidrBlock: Fn.FindInMap('CidrMappings', 'VPC', 'CIDR'),
            EnableDnsHostnames: true,
            EnableDnsSupport: true,
            Tags: [
                new ResourceTag('Name', 'VPC for Personal Media Server on AWS')
            ]
        }),

        InternetGateway: new EC2.InternetGateway().dependsOn('VPC'),

        AttachGateway: new EC2.VPCGatewayAttachment({
            InternetGatewayId: Fn.Ref('InternetGateway'),
            VpcId: Fn.Ref('VPC')
        }).dependsOn(['VPC', 'InternetGateway']),

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
        // End of VPC

        HostedZone: new Route53.HostedZone({
            Name: Fn.Ref('DomainName')
        }),

        SecurityGroup: new EC2.SecurityGroup({
            GroupDescription: 'Personal Media Server Security Group',
            SecurityGroupIngress: [
                // Todo: Remove ssh access
                new EC2.SecurityGroup.Ingress({
                    CidrIp: Fn.Ref('SourceCidr'),
                    FromPort: 22,
                    ToPort: 22,
                    IpProtocol: 'tcp'
                }),
                new EC2.SecurityGroup.Ingress({
                    CidrIp: Fn.Ref('SourceCidr'),
                    FromPort: 80,
                    ToPort: 80,
                    IpProtocol: 'tcp'
                }),
                new EC2.SecurityGroup.Ingress({
                    CidrIp: Fn.Ref('SourceCidr'),
                    FromPort: 443,
                    ToPort: 443,
                    IpProtocol: 'tcp'
                })
            ],
            VpcId: Fn.Ref('VPC')
        }),

        CloudWatchLogsGroup: new Logs.LogGroup({
            RetentionInDays: 7
        }),

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
                AllocationStrategy: 'lowestPrice',
                Type: 'maintain',
                IamFleetRole: Fn.GetAtt('SpotFleetRole', 'Arn'),
                SpotPrice: Fn.Ref('SpotPrice'),
                TargetCapacity: 1,
                TerminateInstancesWithExpiration: true,
                InstanceInterruptionBehavior: 'stop',
                LaunchSpecifications: [
                    createLaunchSpecification('c5.large'),
                    createLaunchSpecification('m5.large')
                ]
            })
        }).dependsOn([
            'SpotFleetRole', 
            'ElasticIp'
        ]),

        ElasticIp: new EC2.EIP({
            Domain: 'vpc'
        }),

        WildcardRecordSet: new Route53.RecordSet({
            Type: 'A',
            HostedZoneId: Fn.Ref('HostedZone'),
            Name: Fn.Join('.', [ '*', Fn.Ref('DomainName')]),
            TTL: '300',
            ResourceRecords: [
                Fn.Ref('ElasticIp')
            ]
        }).dependsOn(['ElasticIp']),

        ProxyRecordSet: new Route53.RecordSet({
            Type: 'A',
            HostedZoneId: Fn.Ref('HostedZone'),
            Name: Fn.Join('.', [ 'proxy', Fn.Ref('DomainName')]),
            TTL: '300',
            ResourceRecords: [
                Fn.Ref('ElasticIp')
            ]
        }).dependsOn(['ElasticIp'])
    }

});

function createLaunchSpecification(instanceType: Value<string>) {
    var allocationId = Fn.GetAtt('ElasticIp', 'AllocationId');
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
                    DeleteOnTermination: true,
                    SnapshotId: Fn.Ref('CacheSnapshotId')
                })
            })
        ],
        UserData: Fn.Base64(Fn.Sub(
            USER_DATA, 
            {
                'RCLONEHOME': '/home/ubuntu/.config/rclone',
                'MOUNTTO': '/media',
                'LOGS': '/var/log/rclone',
                'UPLOADS': '/cache/uploads',
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
            ManagedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AmazonEC2SpotFleetTaggingRole'],
            Path: '/',
            Policies: [
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
                {
                    PolicyDocument: {
                        Version : '2012-10-17',
                        Statement : [
                            {
                                Effect: 'Allow',
                                Action: 'secretsmanager:GetSecretValue',
                                Resource: 'arn:aws:secretsmanager:ap-south-1:782677160809:secret:gdrive-token-EFr0g3'
                            }
                        ]
                    },
                    PolicyName: 'SecretsManagerPolicy'
                },
                {
                    PolicyDocument: {
                        Version : '2012-10-17',
                        Statement : [
                            {
                                Effect: 'Allow',
                                Action: [
                                    "ec2:DescribeAddresses",
                                    "ec2:AllocateAddress",
                                    "ec2:DescribeInstances",
                                    "ec2:AssociateAddress"
                                ],
                                Resource: '*'
                            }
                        ]
                    },
                    PolicyName: 'AssociateElasticIpAddress'
                }
            ]
        },
        Type: 'AWS::IAM::Role'

    }
}
