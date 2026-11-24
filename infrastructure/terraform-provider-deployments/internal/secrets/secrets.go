// Package secrets keeps issued API keys in Parameter Store SecureString parameters.
package secrets

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	"github.com/aws/aws-sdk-go-v2/service/ssm/types"
)

var ErrNotFound = errors.New("parameter not found")

type Record struct {
	ARN     string
	Value   string
	Version string
}

type Store interface {
	Get(ctx context.Context, name string) (Record, error)
	Put(ctx context.Context, name, value string) (Record, error)
}

type AWSStore struct {
	client *ssm.Client
}

func NewAWS(ctx context.Context, region string) (*AWSStore, error) {
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return nil, fmt.Errorf("load AWS config: %w", err)
	}
	return &AWSStore{client: ssm.NewFromConfig(cfg)}, nil
}

func (s *AWSStore) Get(ctx context.Context, name string) (Record, error) {
	out, err := s.client.GetParameter(ctx, &ssm.GetParameterInput{
		Name:           aws.String(name),
		WithDecryption: aws.Bool(true),
	})
	if err != nil {
		var notFound *types.ParameterNotFound
		if errors.As(err, &notFound) {
			return Record{}, ErrNotFound
		}
		return Record{}, err
	}
	parameter := out.Parameter
	if parameter == nil || parameter.ARN == nil {
		return Record{}, fmt.Errorf("parameter store did not return an ARN for %s", name)
	}
	if parameter.Type != types.ParameterTypeSecureString {
		return Record{}, fmt.Errorf("parameter %s must be a SecureString", name)
	}
	return Record{
		ARN:     *parameter.ARN,
		Value:   strings.TrimSpace(aws.ToString(parameter.Value)),
		Version: strconv.FormatInt(parameter.Version, 10),
	}, nil
}

// Put creates the parameter on first write and overwrites it afterwards.
func (s *AWSStore) Put(ctx context.Context, name, value string) (Record, error) {
	out, err := s.client.PutParameter(ctx, &ssm.PutParameterInput{
		Name:      aws.String(name),
		Overwrite: aws.Bool(true),
		Type:      types.ParameterTypeSecureString,
		Value:     aws.String(value),
	})
	if err != nil {
		return Record{}, err
	}
	record, err := s.Get(ctx, name)
	if err != nil {
		return Record{}, err
	}
	record.Version = strconv.FormatInt(out.Version, 10)
	return record, nil
}

type MemoryStore struct {
	records map[string]Record
}

func NewMemory() *MemoryStore {
	return &MemoryStore{records: map[string]Record{}}
}

func (s *MemoryStore) Get(_ context.Context, name string) (Record, error) {
	record, ok := s.records[name]
	if !ok {
		return Record{}, ErrNotFound
	}
	return record, nil
}

func (s *MemoryStore) Put(_ context.Context, name, value string) (Record, error) {
	record, ok := s.records[name]
	if !ok {
		record = Record{ARN: "arn:aws:ssm:us-east-2:123456789012:parameter" + name}
	}
	version, _ := strconv.Atoi(record.Version)
	record.Value = value
	record.Version = strconv.Itoa(version + 1)
	s.records[name] = record
	return record, nil
}

func (s *MemoryStore) Seed(name, arn, value string) {
	s.records[name] = Record{ARN: arn, Value: value, Version: "1"}
}
