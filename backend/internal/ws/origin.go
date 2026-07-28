package ws

import (
	"net/http"
	"net/url"
	"os"
	"strings"
)

func isAllowedOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}

	if allowedOrigins := os.Getenv("WS_ALLOWED_ORIGINS"); allowedOrigins != "" {
		for allowedOrigin := range strings.SplitSeq(allowedOrigins, ",") {
			if strings.TrimSpace(allowedOrigin) == origin {
				return true
			}
		}
		return false
	}

	parsedOrigin, err := url.Parse(origin)
	if err != nil {
		return false
	}

	if strings.EqualFold(parsedOrigin.Host, r.Host) {
		return true
	}

	originHost := parsedOrigin.Hostname()
	return originHost == "localhost" || originHost == "127.0.0.1"
}
