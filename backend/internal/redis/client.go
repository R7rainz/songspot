package redis

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

var ctx = context.Background()

type Client struct {
	rdb *redis.Client
}

// establishes the connection to the redis client
func NewClient(addr string, password string) *Client {
	rdb := redis.NewClient(&redis.Options{
		Addr:     addr,
		Password: password,
		DB:       0,
	})

	return &Client{rdb: rdb}
}

// Queue management over here
func (c *Client) AddSongToQueue(roomID string, youtubeID string) error {
	key := fmt.Sprintf("room:%s:queue", roomID)

	// ZAdd NX means "Only add if it does Not eXist".
	// Prevents resetting the votes if someone tries to add the same song twice
	err := c.rdb.ZAddNX(ctx, key, redis.Z{
		Score:  0,
		Member: youtubeID,
	}).Err()

	return err
}

func (c *Client) VoteForSong(roomID string, youtubeID string, vote int) error {
	key := fmt.Sprintf("room:%s:queue", roomID)

	// ZIncrBy handles the atomic math.
	_, err := c.rdb.ZIncrBy(ctx, key, float64(vote), youtubeID).Result()

	return err
}

// fetching data
func (c *Client) GetQueue(roomID string) ([]redis.Z, error) {
	key := fmt.Sprintf("room:%s:queue", roomID)

	// ZRevRangeWithScores gets the list ordered from highest score to lowest
	// 0, -1 means "get all items from start to end"
	return c.rdb.ZRevRangeWithScores(ctx, key, 0, -1).Result()
}

func (c *Client) SaveSongMetadata(youtubeID, title, thumbnail string, duration int) error {
	key := fmt.Sprintf("song:%s", youtubeID)

	err := c.rdb.HSet(ctx, key, map[string]interface{}{
		"title":     title,
		"thumbnail": thumbnail,
		"duration":  duration,
	}).Err()

	return err
}

func (c *Client) UpdatePlaybackState(roomID, currentSong string, isPlaying bool, syncTimeMS int64) error {
	key := fmt.Sprintf("room:%s:state", roomID)

	err := c.rdb.HSet(ctx, key, map[string]interface{}{
		"current_song": currentSong,
		"is_playing":   isPlaying,
		"sync_time_ms": syncTimeMS,
		"updated_at":   time.Now().UnixMilli(),
	}).Err()

	return err
}

// invites
func (c *Client) CreateInvite(token, roomID, hostName string, maxUses int, expireMinutes int) error {
	key := fmt.Sprintf("invite:%s", token)

	err := c.rdb.HSet(ctx, key, map[string]interface{}{
		"room_id":   roomID,
		"host_name": hostName,
		"max_uses":  maxUses,
		"use_count": 0,
	}).Err()
	if err != nil {
		return err
	}

	return c.rdb.Expire(ctx, key, time.Duration(expireMinutes)*time.Minute).Err()
}

func (c *Client) UseInvite(token string) (string, error) {
	key := fmt.Sprintf("invite:%s", token)

	exists, err := c.rdb.Exists(ctx, key).Result()
	if err != nil {
		return "", err
	}
	if exists == 0 {
		return "", fmt.Errorf("invite expired or invalid")
	}

	maxUses, err := c.rdb.HGet(ctx, key, "max_uses").Int()
	if err == redis.Nil {
		maxUses = 0
	} else if err != nil {
		return "", err
	}

	useCount, err := c.rdb.HGet(ctx, key, "use_count").Int()
	if err == redis.Nil {
		useCount = 0
	} else if err != nil {
		return "", err
	}

	if maxUses > 0 && useCount >= maxUses {
		return "", fmt.Errorf("invite use limit reached")
	}

	newCount, err := c.rdb.HIncrBy(ctx, key, "use_count", 1).Result()
	if err != nil {
		return "", err
	}

	if maxUses > 0 && int(newCount) > maxUses {
		return "", fmt.Errorf("invite use limit reached")
	}

	return c.rdb.HGet(ctx, key, "room_id").Result()
}
