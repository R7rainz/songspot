package store

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"songspot/internal/models"

	"github.com/redis/go-redis/v9"
)

const (
	roomPrefix        = "room:"
	invitePrefix      = "invite:"
	searchCachePrefix = "search:"
	roomEventPrefix   = "room_events:"
)

// RedisStore owns all Redis key shapes and JSON encoding for backend state.
type RedisStore struct {
	client *redis.Client
}

func NewRedisStore(client *redis.Client) *RedisStore {
	return &RedisStore{client: client}
}

func (s *RedisStore) RoomExists(ctx context.Context, roomID string) (bool, error) {
	exists, err := s.client.Exists(ctx, roomKey(roomID)).Result()
	if err != nil {
		return false, err
	}
	return exists > 0, nil
}

func (s *RedisStore) GetRoom(ctx context.Context, roomID string) (*models.RoomData, error) {
	data, err := s.client.Get(ctx, roomKey(roomID)).Result()
	if err != nil {
		return nil, err
	}

	var room models.RoomData
	if err := json.Unmarshal([]byte(data), &room); err != nil {
		return nil, err
	}
	return &room, nil
}

func (s *RedisStore) SaveRoom(ctx context.Context, roomID string, room *models.RoomData) error {
	data, err := json.Marshal(room)
	if err != nil {
		return err
	}
	return s.client.Set(ctx, roomKey(roomID), data, models.RoomTTL).Err()
}

func (s *RedisStore) CreateRoomIfAbsent(ctx context.Context, roomID string, room *models.RoomData) (bool, error) {
	data, err := json.Marshal(room)
	if err != nil {
		return false, err
	}
	return s.client.SetNX(ctx, roomKey(roomID), data, models.RoomTTL).Result()
}

func (s *RedisStore) SaveInvite(ctx context.Context, token string, invite models.InviteToken) error {
	data, err := json.Marshal(invite)
	if err != nil {
		return err
	}
	return s.client.Set(ctx, inviteKey(token), data, time.Until(invite.ExpiresAt)).Err()
}

func (s *RedisStore) GetInvite(ctx context.Context, token string) (*models.InviteToken, error) {
	data, err := s.client.Get(ctx, inviteKey(token)).Result()
	if err != nil {
		return nil, err
	}

	var invite models.InviteToken
	if err := json.Unmarshal([]byte(data), &invite); err != nil {
		return nil, err
	}
	return &invite, nil
}

func (s *RedisStore) PublishRoomEvent(ctx context.Context, roomID string, payload []byte) error {
	return s.client.Publish(ctx, RoomEventChannel(roomID), payload).Err()
}

func (s *RedisStore) SubscribeRoomEvents(ctx context.Context, roomID string) *redis.PubSub {
	return s.client.Subscribe(ctx, RoomEventChannel(roomID))
}

func (s *RedisStore) GetSearchCache(ctx context.Context, key string) (string, error) {
	return s.client.Get(ctx, key).Result()
}

func (s *RedisStore) SaveSearchCache(ctx context.Context, key string, payload []byte, ttl time.Duration) error {
	return s.client.Set(ctx, key, payload, ttl).Err()
}

func SearchCacheKey(query string, limit int) string {
	return searchCachePrefix + strconv.Itoa(limit) + ":" + strings.ToLower(strings.TrimSpace(query))
}

func RoomEventChannel(roomID string) string {
	return roomEventPrefix + roomID
}

func roomKey(roomID string) string {
	return roomPrefix + roomID
}

func inviteKey(token string) string {
	return invitePrefix + token
}
