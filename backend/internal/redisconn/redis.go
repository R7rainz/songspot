package redisconn

import (
	"context"
	"strings"

	"github.com/redis/go-redis/v9"
)

// Connect creates and verifies the Redis client used by the backend.
func Connect(ctx context.Context, rawURL string) (*redis.Client, error) {
	opts, err := Options(rawURL)
	if err != nil {
		return nil, err
	}

	client := redis.NewClient(opts)
	if err := client.Ping(ctx).Err(); err != nil {
		client.Close()
		return nil, err
	}
	return client, nil
}

// Options accepts either a full connection URL (redis://..., or rediss://...
// with TLS + auth) or a bare host:port for local development.
func Options(rawURL string) (*redis.Options, error) {
	if strings.Contains(rawURL, "://") {
		return redis.ParseURL(rawURL)
	}
	return &redis.Options{Addr: rawURL}, nil
}
