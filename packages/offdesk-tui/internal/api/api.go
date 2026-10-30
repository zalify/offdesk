// Package api maps the Hub's documented application API.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"offdesk-tui/internal/transport"
)

type Machine struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	OS   string `json:"os"`
	Home string `json:"home_dir"`
}
type Terminal struct {
	ID        string `json:"id"`
	Machine   string `json:"machine_id"`
	Title     string `json:"title"`
	Cwd       string `json:"cwd"`
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
	Reachable bool   `json:"reachable"`
}
type API struct {
	C      *transport.Client
	Device string
}

func (a API) Do(ctx context.Context, method, path string, body, out any) error {
	var payload *string
	if body != nil {
		b, e := json.Marshal(body)
		if e != nil {
			return e
		}
		s := string(b)
		payload = &s
	}
	m, e := a.C.Request(ctx, method, path, payload)
	if e != nil {
		return e
	}
	if out != nil && m.Body != nil && *m.Body != "" {
		return json.Unmarshal([]byte(*m.Body), out)
	}
	return nil
}
func (a API) Machines(ctx context.Context) (v []Machine, e error) {
	e = a.Do(ctx, "GET", "/api/machines", nil, &v)
	return
}
func (a API) Terminals(ctx context.Context) (v []Terminal, e error) {
	e = a.Do(ctx, "GET", "/api/terminals", nil, &v)
	return
}

// ForegroundProcess returns the node's best-effort process name for the
// Offdesk-managed pane. Nested tmux windows are not enumerated by this API.
func (a API) ForegroundProcess(ctx context.Context, machine, terminal string) (string, error) {
	var result struct {
		Name *string `json:"process_name"`
	}
	err := a.Do(ctx, "GET", MachinePath(machine)+"/terminals/"+url.PathEscape(terminal)+"/foreground-process", nil, &result)
	if err != nil || result.Name == nil {
		return "", err
	}
	return *result.Name, nil
}
func MachinePath(machine string) string { return "/api/machines/" + url.PathEscape(machine) }
func (a API) Control(ctx context.Context, machine string, claim bool) error {
	op := "release"
	if claim {
		op = "control"
	}
	return a.Do(ctx, "POST", "/api/mode/"+op, map[string]string{"machine_id": machine, "device_id": a.Device}, nil)
}
func (a API) Controller(ctx context.Context, machine string) (string, error) {
	var v struct {
		Device *string `json:"controller_device_id"`
	}
	e := a.Do(ctx, "GET", "/api/mode?machine_id="+url.QueryEscape(machine), nil, &v)
	if e != nil || v.Device == nil {
		return "", e
	}
	return *v.Device, nil
}
func (a API) Create(ctx context.Context, machine, cwd string, cols, rows int) (v Terminal, e error) {
	return a.CreateWithStartup(ctx, machine, cwd, cols, rows, "")
}
func (a API) CreateWithStartup(ctx context.Context, machine, cwd string, cols, rows int, startup string) (v Terminal, e error) {
	body := map[string]any{"cwd": cwd, "device_id": a.Device, "cols": cols, "rows": rows}
	if startup != "" {
		body["startup_command"] = startup
	}
	e = a.Do(ctx, "POST", MachinePath(machine)+"/terminals", body, &v)
	return
}
func (a API) Destroy(ctx context.Context, machine, id string) error {
	return a.Do(ctx, "DELETE", MachinePath(machine)+"/terminals/"+url.PathEscape(id)+"?device_id="+url.QueryEscape(a.Device), nil, nil)
}
func (a API) Me(ctx context.Context) error {
	var v json.RawMessage
	return a.Do(ctx, "GET", "/api/auth/me", nil, &v)
}
func (a API) ListFiles(ctx context.Context, machine, path string) (json.RawMessage, error) {
	var v json.RawMessage
	e := a.Do(ctx, "GET", MachinePath(machine)+"/fs/list?path="+url.QueryEscape(path), nil, &v)
	return v, e
}
func (a API) String() string { return fmt.Sprintf("Offdesk device %s", a.Device) }
