package music

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"songspot/internal/models"
)

const (
	innerTubeBase = "https://www.youtube.com/youtubei/v1"
	// Public web-client key baked into youtube.com; not a secret and not
	// quota-limited (it's the InnerTube key, not a Data API key).
	innerTubeKey           = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"
	innerTubeClientVersion = "2.20240401.01.00"
	userAgent              = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

	// Bound how much of a huge playlist we'll pull, to cap latency and memory.
	maxPlaylistSongs = 300
)

// InnerTube is the default keyless YouTube Provider. It also imports playlists.
type InnerTube struct {
	http *http.Client
}

// NewInnerTube returns a Provider backed by YouTube's InnerTube API.
func NewInnerTube() *InnerTube {
	return &InnerTube{http: &http.Client{Timeout: 12 * time.Second}}
}

func clientContext() map[string]any {
	return map[string]any{
		"client": map[string]any{
			"clientName":    "WEB",
			"clientVersion": innerTubeClientVersion,
			"hl":            "en",
			"gl":            "US",
		},
	}
}

// Search returns up to `limit` videos for a text query.
func (c *InnerTube) Search(ctx context.Context, query string, limit int) ([]models.Song, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, fmt.Errorf("empty query")
	}
	root, err := c.post(ctx, "/search", map[string]any{
		"context": clientContext(),
		"query":   query,
	})
	if err != nil {
		return nil, err
	}
	return extractSongs(root, "videoRenderer", limit), nil
}

// Playlist returns the videos in a YouTube playlist by its id (the `list=` value).
//
// It reads the playlist's HTML page (whose embedded ytInitialData carries the
// first page of items) and then follows continuation tokens via the browse API.
// The HTML page is used because the browse API alone defers the item list behind
// a consent-gated continuation that returns nothing without cookies.
func (c *InnerTube) Playlist(ctx context.Context, playlistID string) ([]models.Song, error) {
	playlistID = strings.TrimSpace(playlistID)
	if playlistID == "" {
		return nil, fmt.Errorf("empty playlist id")
	}

	root, err := c.playlistPage(ctx, playlistID)
	if err != nil {
		return nil, err
	}

	var songs []models.Song
	seen := map[string]bool{}
	appendPage := func(node any) int {
		added := 0
		for _, s := range playlistSongs(node) {
			if s.ID != "" && !seen[s.ID] {
				seen[s.ID] = true
				songs = append(songs, s)
				added++
			}
		}
		return added
	}

	appendPage(root)
	token := continuationToken(root)
	for token != "" && len(songs) < maxPlaylistSongs {
		cont, err := c.post(ctx, "/browse", map[string]any{
			"context":      clientContext(),
			"continuation": token,
		})
		if err != nil {
			break
		}
		if appendPage(cont) == 0 {
			break
		}
		next := continuationToken(cont)
		if next == token {
			break
		}
		token = next
	}
	return songs, nil
}

// post sends an InnerTube API request and returns the decoded JSON as a generic
// tree (map/slice), which the parsers walk. Working with a generic tree keeps
// parsing resilient to YouTube's frequent, deeply-nested layout changes.
func (c *InnerTube) post(ctx context.Context, path string, payload any) (any, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	endpoint := innerTubeBase + path + "?key=" + innerTubeKey
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Origin", "https://www.youtube.com")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("innertube %s: status %d", path, resp.StatusCode)
	}
	var root any
	if err := json.NewDecoder(resp.Body).Decode(&root); err != nil {
		return nil, err
	}
	return root, nil
}

// playlistPage fetches the playlist's HTML page and returns its ytInitialData.
func (c *InnerTube) playlistPage(ctx context.Context, playlistID string) (any, error) {
	pageURL := "https://www.youtube.com/playlist?list=" + url.QueryEscape(playlistID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, pageURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	// Pre-accept the EU consent interstitial so we get real page content.
	req.Header.Set("Cookie", "SOCS=CAISNggC")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("playlist page: status %d", resp.StatusCode)
	}
	html, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20)) // cap at 8 MiB
	if err != nil {
		return nil, err
	}
	return extractInitialData(html)
}

// ParsePlaylistID extracts a playlist id from a URL (the `list=` query param) or
// returns the input unchanged if it already looks like a bare playlist id.
func ParsePlaylistID(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if u, err := url.Parse(raw); err == nil {
		if list := u.Query().Get("list"); list != "" {
			return list
		}
	}
	// Bare id (PL…, OLAK…, RD…, etc.) with no URL wrapping.
	if !strings.Contains(raw, "/") && !strings.Contains(raw, "?") {
		return raw
	}
	return ""
}

// --- response parsing ------------------------------------------------------

// extractSongs walks the tree collecting every renderer of the given kind
// ("videoRenderer" for search, "playlistVideoRenderer" for legacy playlists),
// de-duplicated by video id. A limit of 0 means no limit.
func extractSongs(root any, rendererKey string, limit int) []models.Song {
	var renderers []map[string]any
	walk(root, rendererKey, &renderers)

	songs := make([]models.Song, 0, len(renderers))
	seen := map[string]bool{}
	for _, m := range renderers {
		song, ok := songFromRenderer(m)
		if !ok || seen[song.ID] {
			continue
		}
		seen[song.ID] = true
		songs = append(songs, song)
		if limit > 0 && len(songs) >= limit {
			break
		}
	}
	return songs
}

// playlistSongs pulls songs from a playlist page/continuation, handling both the
// current `lockupViewModel` component and the legacy `playlistVideoRenderer`.
func playlistSongs(root any) []models.Song {
	var out []models.Song

	var lockups []map[string]any
	walk(root, "lockupViewModel", &lockups)
	for _, m := range lockups {
		if s, ok := songFromLockup(m); ok {
			out = append(out, s)
		}
	}

	var renderers []map[string]any
	walk(root, "playlistVideoRenderer", &renderers)
	for _, m := range renderers {
		if s, ok := songFromRenderer(m); ok {
			out = append(out, s)
		}
	}
	return out
}

// walk recursively collects the map value found under `key` anywhere in the tree.
func walk(node any, key string, out *[]map[string]any) {
	switch n := node.(type) {
	case map[string]any:
		if v, ok := n[key]; ok {
			if m, ok := v.(map[string]any); ok {
				*out = append(*out, m)
			}
		}
		for _, v := range n {
			walk(v, key, out)
		}
	case []any:
		for _, v := range n {
			walk(v, key, out)
		}
	}
}

// songFromRenderer maps a videoRenderer / playlistVideoRenderer to a Song.
func songFromRenderer(m map[string]any) (models.Song, bool) {
	id := getString(m, "videoId")
	if id == "" {
		return models.Song{}, false
	}
	channel := richText(m["shortBylineText"])
	if channel == "" {
		channel = richText(m["ownerText"])
	}
	duration := 0
	if ls := getString(m, "lengthSeconds"); ls != "" {
		duration, _ = strconv.Atoi(ls)
	} else {
		duration = parseDuration(richText(m["lengthText"]))
	}
	return models.Song{
		ID:        id,
		Title:     richText(m["title"]),
		Duration:  duration,
		// Clean, unsigned thumbnail URL — always loads, unlike InnerTube's
		// signed (sqp) variants which can 403 without a matching referer.
		Thumbnail: thumbFor(id),
		Channel:   channel,
	}, true
}

// songFromLockup maps the newer lockupViewModel component to a Song. Non-video
// lockups (playlists, channels, mixes) have a non-11-char contentId and skip.
func songFromLockup(m map[string]any) (models.Song, bool) {
	id := getString(m, "contentId")
	if len(id) != 11 {
		return models.Song{}, false
	}
	title := nestedString(m, "metadata", "lockupMetadataViewModel", "title", "content")

	// Duration lives in a thumbnail overlay badge, e.g. text "4:30" or "1:02:03".
	duration := 0
	var badges []map[string]any
	walk(m, "thumbnailBadgeViewModel", &badges)
	for _, b := range badges {
		if d := parseDuration(getString(b, "text")); d > 0 {
			duration = d
			break
		}
	}

	return models.Song{
		ID:        id,
		Title:     title,
		Duration:  duration,
		Thumbnail: thumbFor(id),
	}, true
}

// continuationToken finds the first continuation token in the tree, used to page
// through long playlists.
func continuationToken(root any) string {
	var cmds []map[string]any
	walk(root, "continuationCommand", &cmds)
	for _, c := range cmds {
		if t := getString(c, "token"); t != "" {
			return t
		}
	}
	return ""
}

// extractInitialData pulls the ytInitialData JSON object out of a YouTube HTML
// page via balanced-brace scanning (more robust than a regexp against the huge,
// nested blob).
func extractInitialData(html []byte) (any, error) {
	s := string(html)
	for _, marker := range []string{"ytInitialData = ", "ytInitialData=", "var ytInitialData = "} {
		idx := strings.Index(s, marker)
		if idx < 0 {
			continue
		}
		start := strings.IndexByte(s[idx:], '{')
		if start < 0 {
			continue
		}
		obj := scanBalancedObject(s, idx+start)
		if obj == "" {
			continue
		}
		var root any
		if err := json.Unmarshal([]byte(obj), &root); err == nil {
			return root, nil
		}
	}
	return nil, fmt.Errorf("ytInitialData not found")
}

// scanBalancedObject returns the JSON object beginning at s[start]=='{', matching
// braces while respecting string literals and escapes.
func scanBalancedObject(s string, start int) string {
	depth := 0
	inStr := false
	esc := false
	for i := start; i < len(s); i++ {
		ch := s[i]
		if inStr {
			switch {
			case esc:
				esc = false
			case ch == '\\':
				esc = true
			case ch == '"':
				inStr = false
			}
			continue
		}
		switch ch {
		case '"':
			inStr = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return s[start : i+1]
			}
		}
	}
	return ""
}

// --- small helpers ---------------------------------------------------------

func thumbFor(id string) string {
	return "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg"
}

// richText reads YouTube's text objects, which are either {simpleText} or {runs}.
func richText(v any) string {
	m, ok := v.(map[string]any)
	if !ok {
		return ""
	}
	if s, ok := m["simpleText"].(string); ok {
		return s
	}
	runs, ok := m["runs"].([]any)
	if !ok {
		return ""
	}
	var b strings.Builder
	for _, r := range runs {
		if rm, ok := r.(map[string]any); ok {
			if t, ok := rm["text"].(string); ok {
				b.WriteString(t)
			}
		}
	}
	return b.String()
}

// nestedString walks a chain of map keys and returns the string leaf, or "".
func nestedString(m map[string]any, path ...string) string {
	var cur any = m
	for _, k := range path {
		mm, ok := cur.(map[string]any)
		if !ok {
			return ""
		}
		cur = mm[k]
	}
	s, _ := cur.(string)
	return s
}

func getString(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

// parseDuration turns "3:45" or "1:02:03" into seconds. Empty or unparseable
// (e.g. a live stream) yields 0.
func parseDuration(s string) int {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	parts := strings.Split(s, ":")
	total := 0
	for _, p := range parts {
		n, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil {
			return 0
		}
		total = total*60 + n
	}
	return total
}
