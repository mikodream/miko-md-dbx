// Command miko-md-notes is the native Go sidecar backend for the MIKO.MD notes
// DBX plugin (id miko.md.notes, version 0.1.0).
//
// Transport is newline-delimited JSON-RPC 2.0 over stdin/stdout: exactly one
// encoded message per line. stdout carries protocol traffic only; every log,
// warning and recovered panic stack goes to stderr.
package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Identity and protocol facts. Kept in one place so initialize, notes/info and
// the stderr banner can never disagree.
const (
	pluginID        = "miko.md.notes"
	pluginVersion   = "0.1.4"
	protocolVersion = 1

	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
	codeRuntimeError   = -32000
	codeSessionMissing = -32001

	maxInlineBytes    = 4 << 20   // inline read/write ceiling for filesystem/*
	maxNoteBytes      = 4 << 20   // notes/read ceiling
	maxImageBytes     = 8 << 20   // notes/saveImage decoded ceiling
	maxExportBytes    = 8 << 20   // notes/exportNote ceiling
	maxBackupEntry    = 64 << 20  // single file skipped by backup
	maxImportFolder   = 16 << 20  // single file skipped by notes/importFolder
	maxRestoreTotal   = 256 << 20 // cumulative restore upload ceiling
	maxRestoreEntry   = 64 << 20  // single zip entry ceiling during restore
	maxSearchLimit    = 200       // notes/search hard cap
	maxTreePerLevel   = 2000      // notes/tree per-directory node cap
	maxTreeDepth      = 12
	defaultTreeDepth  = 6
	defaultPageLimit  = 200
	maxPageLimit      = 500
	defaultReadLength = 1 << 20
	maxReadLength     = 4 << 20
)

// rpcRequest is one decoded protocol request. ID is kept raw so numbers and
// strings round-trip byte for byte.
type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcSuccess struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result"`
}

type rpcFailure struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Error   rpcError        `json:"error"`
}

func protoErr(code int, prefix, detail string) *rpcError {
	if detail == "" {
		return &rpcError{Code: code, Message: prefix}
	}
	return &rpcError{Code: code, Message: prefix + ": " + detail}
}

func errParams(prefix, detail string) *rpcError {
	return protoErr(codeInvalidParams, prefix, detail)
}

func errRuntime(prefix, detail string) *rpcError {
	return protoErr(codeRuntimeError, prefix, detail)
}

func errSession() *rpcError {
	return protoErr(codeSessionMissing, "SESSION_MISSING", "连接未打开")
}

func logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[miko-md-notes] "+format+"\n", args...)
}

// rawParams is a tolerant view over params: every field is kept raw so that a
// type mismatch in one field never fails the whole request.
type rawParams map[string]json.RawMessage

func parseParams(raw json.RawMessage) (rawParams, *rpcError) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return rawParams{}, nil
	}
	var m rawParams
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, errParams("INVALID_REQUEST", "params 必须是 JSON 对象")
	}
	if m == nil {
		m = rawParams{}
	}
	return m, nil
}

func nonNull(raw json.RawMessage) json.RawMessage {
	t := bytes.TrimSpace(raw)
	if len(t) == 0 || bytes.Equal(t, []byte("null")) {
		return nil
	}
	return raw
}

func rawToString(raw json.RawMessage) (string, bool) {
	t := bytes.TrimSpace(raw)
	if len(t) == 0 || bytes.Equal(t, []byte("null")) {
		return "", false
	}
	switch t[0] {
	case '"':
		var s string
		if err := json.Unmarshal(t, &s); err != nil {
			return "", false
		}
		return s, true
	case '{', '[':
		return "", false
	}
	return string(t), true
}

func rawToFloat(raw json.RawMessage) (float64, bool) {
	t := bytes.TrimSpace(raw)
	if len(t) == 0 || bytes.Equal(t, []byte("null")) {
		return 0, false
	}
	if t[0] == '"' {
		var s string
		if err := json.Unmarshal(t, &s); err != nil {
			return 0, false
		}
		t = []byte(strings.TrimSpace(s))
		if len(t) == 0 {
			return 0, false
		}
	}
	v, err := strconv.ParseFloat(string(t), 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// parseBoolRaw is deliberately loose: hosts have been known to serialize
// booleans as the strings "true" / "false".
func parseBoolRaw(raw json.RawMessage) (bool, bool) {
	t := bytes.TrimSpace(raw)
	if len(t) == 0 || bytes.Equal(t, []byte("null")) {
		return false, false
	}
	s := strings.ToLower(strings.TrimSpace(string(t)))
	s = strings.Trim(s, `"`)
	switch s {
	case "true", "1", "yes", "on", "y", "t":
		return true, true
	case "false", "0", "no", "off", "n", "f", "":
		return false, true
	}
	return false, false
}

func (p rawParams) raw(key string) json.RawMessage {
	if p == nil {
		return nil
	}
	return nonNull(p[key])
}

func (p rawParams) has(key string) bool {
	return p.raw(key) != nil
}

func (p rawParams) str(key string) string {
	raw := p.raw(key)
	if raw == nil {
		return ""
	}
	s, _ := rawToString(raw)
	return s
}

func (p rawParams) boolean(key string, def bool) bool {
	raw := p.raw(key)
	if raw == nil {
		return def
	}
	if v, ok := parseBoolRaw(raw); ok {
		return v
	}
	return def
}

func (p rawParams) intParam(key string, def int64) int64 {
	raw := p.raw(key)
	if raw == nil {
		return def
	}
	if v, ok := rawToFloat(raw); ok {
		return int64(v)
	}
	return def
}

func (p rawParams) floatParam(key string) (float64, bool) {
	return rawToFloat(p.raw(key))
}

func (p rawParams) object(key string) map[string]json.RawMessage {
	raw := p.raw(key)
	if raw == nil {
		return nil
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	return m
}

// connSpec is the connection object as sent by the Host, with the loose
// external_config flattening the SPEC asks for.
type connSpec struct {
	id           string
	name         string
	vaultPath    json.RawMessage
	assetsDir    json.RawMessage
	trashEnabled json.RawMessage
	external     map[string]json.RawMessage
}

func (p rawParams) conn() connSpec {
	var c connSpec
	raw := p.raw("connection")
	if raw == nil {
		return c
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return c
	}
	c.id, _ = rawToString(m["id"])
	c.name, _ = rawToString(m["name"])
	c.vaultPath = nonNull(m["vault_path"])
	c.assetsDir = nonNull(m["assets_dir"])
	c.trashEnabled = nonNull(m["trash_enabled"])
	if ec := nonNull(m["external_config"]); ec != nil {
		var obj map[string]json.RawMessage
		if json.Unmarshal(ec, &obj) == nil {
			c.external = obj
		} else {
			// Some hosts string-encode external_config; accept that too.
			var str string
			if json.Unmarshal(ec, &str) == nil && json.Unmarshal([]byte(str), &obj) == nil {
				c.external = obj
			}
		}
	}
	return c
}

// lookup implements the fallback order SPEC §3 requires:
// external_config[key] → connection[key] → (caller default).
func (c connSpec) lookup(key string) json.RawMessage {
	if c.external != nil {
		if r := nonNull(c.external[key]); r != nil {
			return r
		}
	}
	switch key {
	case "vault_path":
		return c.vaultPath
	case "assets_dir":
		return c.assetsDir
	case "trash_enabled":
		return c.trashEnabled
	}
	return nil
}

func (c connSpec) lookupStr(key string) (string, bool) {
	raw := c.lookup(key)
	if raw == nil {
		return "", false
	}
	return rawToString(raw)
}

func (c connSpec) lookupBool(key string) (bool, bool) {
	raw := c.lookup(key)
	if raw == nil {
		return false, false
	}
	return parseBoolRaw(raw)
}

type handlerFunc func(rawParams) (any, *rpcError)

type server struct {
	handlers map[string]handlerFunc

	mu       sync.Mutex
	sessions map[string]*Vault

	handleMu sync.Mutex
	backups  map[string]*backupHandle
	restores map[string]*restoreHandle

	outMu sync.Mutex
	out   io.Writer
}

func newServer() *server {
	s := &server{
		sessions: map[string]*Vault{},
		backups:  map[string]*backupHandle{},
		restores: map[string]*restoreHandle{},
		out:      os.Stdout,
	}
	s.handlers = map[string]handlerFunc{
		"plugin/initialize": s.pluginInitialize,

		"connection/test":       s.connectionTest,
		"connection/connect":    s.connectionConnect,
		"connection/disconnect": s.connectionDisconnect,
		"connection/action":     s.connectionAction,

		"notes/info":         s.notesInfo,
		"notes/tree":         s.notesTree,
		"notes/list":         s.notesList,
		"notes/read":         s.notesRead,
		"notes/write":        s.notesWrite,
		"notes/create":       s.notesCreate,
		"notes/rename":       s.notesRename,
		"notes/move":         s.notesMove,
		"notes/mkdir":        s.notesMkdir,
		"notes/delete":       s.notesDelete,
		"notes/search":       s.notesSearch,
		"notes/saveImage":    s.notesSaveImage,
		"notes/importFile":   s.notesImportFile,
		"notes/importFolder": s.notesImportFolder,
		"notes/readAsset":    s.notesReadAsset,
		"notes/exportNote":   s.notesExportNote,

		"notes/backupBegin":   s.notesBackupBegin,
		"notes/backupRead":    s.notesBackupRead,
		"notes/backupEnd":     s.notesBackupEnd,
		"notes/restoreBegin":  s.notesRestoreBegin,
		"notes/restoreChunk":  s.notesRestoreChunk,
		"notes/restoreCommit": s.notesRestoreCommit,
		"notes/restoreAbort":  s.notesRestoreAbort,

		"filesystem/list":            s.fsList,
		"filesystem/read":            s.fsRead,
		"filesystem/write":           s.fsWrite,
		"filesystem/createDirectory": s.fsCreateDirectory,
		"filesystem/delete":          s.fsDelete,
		"filesystem/rename":          s.fsRename,
	}
	return s
}

func main() {
	logf("sidecar starting id=%s version=%s protocol=%d", pluginID, pluginVersion, protocolVersion)
	srv := newServer()

	// 1 MiB buffer + ReadBytes keeps arbitrarily long lines intact; a default
	// bufio.Scanner would cap lines at 64 KiB and silently truncate messages.
	in := bufio.NewReaderSize(os.Stdin, 1<<20)
	for {
		line, rerr := in.ReadBytes('\n')
		if trimmed := bytes.TrimSpace(line); len(trimmed) > 0 {
			srv.handleLine(trimmed)
		}
		if rerr != nil {
			if rerr == io.EOF {
				logf("stdin closed, exiting")
			} else {
				logf("stdin read error: %v", rerr)
			}
			return
		}
	}
}

func (s *server) handleLine(line []byte) {
	var req rpcRequest
	if err := json.Unmarshal(line, &req); err != nil {
		logf("bad request line: %v", err)
		s.writeFailure(json.RawMessage("null"), errParams("INVALID_REQUEST", "无法解析 JSON-RPC 请求"))
		return
	}
	id := nonNull(req.ID)
	if id == nil {
		id = json.RawMessage("null")
	}
	result, rerr := s.invoke(req.Method, req.Params)
	if rerr != nil {
		s.writeFailure(id, rerr)
		return
	}
	s.writeSuccess(id, result)
}

// invoke funnels every handler through a recover so a panic can never take the
// sidecar down: it becomes a -32000 response instead.
func (s *server) invoke(method string, params json.RawMessage) (result any, rerr *rpcError) {
	defer func() {
		if r := recover(); r != nil {
			logf("panic while handling %q: %v\n%s", method, r, debug.Stack())
			result = nil
			rerr = &rpcError{
				Code:    codeRuntimeError,
				Message: fmt.Sprintf("IO_ERROR: 内部错误: %v", r),
			}
		}
	}()

	h, ok := s.handlers[method]
	if !ok {
		return nil, protoErr(codeMethodNotFound, "METHOD_NOT_FOUND", "未知方法: "+method)
	}
	p, perr := parseParams(params)
	if perr != nil {
		return nil, perr
	}
	return h(p)
}

func (s *server) writeSuccess(id json.RawMessage, result any) {
	payload, err := json.Marshal(rpcSuccess{JSONRPC: "2.0", ID: id, Result: result})
	if err != nil {
		logf("marshal result for id=%s: %v", string(id), err)
		s.writeFailure(id, errRuntime("IO_ERROR", "结果序列化失败"))
		return
	}
	s.writeLine(payload)
}

func (s *server) writeFailure(id json.RawMessage, rerr *rpcError) {
	payload, err := json.Marshal(rpcFailure{JSONRPC: "2.0", ID: id, Error: *rerr})
	if err != nil {
		logf("marshal error for id=%s: %v", string(id), err)
		return
	}
	s.writeLine(payload)
}

// writeLine emits exactly one JSON message plus a newline in a single write.
func (s *server) writeLine(payload []byte) {
	buf := make([]byte, len(payload)+1)
	copy(buf, payload)
	buf[len(payload)] = '\n'
	s.outMu.Lock()
	_, err := s.out.Write(buf)
	s.outMu.Unlock()
	if err != nil {
		logf("write stdout: %v", err)
	}
}

// session returns the vault registered for connectionId.
func (s *server) session(id string) (*Vault, *rpcError) {
	if strings.TrimSpace(id) == "" {
		return nil, errSession()
	}
	s.mu.Lock()
	v, ok := s.sessions[id]
	s.mu.Unlock()
	if !ok || v == nil {
		return nil, errSession()
	}
	return v, nil
}

// fsVault resolves the identity for filesystem/*: an explicit connectionId
// wins; otherwise the single live session is used.
func (s *server) fsVault(p rawParams) (*Vault, *rpcError) {
	id := p.str("connectionId")
	if strings.TrimSpace(id) != "" {
		return s.session(id)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.sessions) == 1 {
		for _, v := range s.sessions {
			if v != nil {
				return v, nil
			}
		}
	}
	return nil, errSession()
}

// ---------------------------------------------------------------- plugin ----

func (s *server) pluginInitialize(p rawParams) (any, *rpcError) {
	if raw := p.raw("plugin"); raw != nil {
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(raw, &obj); err != nil {
			return nil, errParams("IDENTITY_MISMATCH", "plugin 必须是对象")
		}
		id, _ := rawToString(obj["id"])
		version, _ := rawToString(obj["version"])
		if id != pluginID {
			return nil, errParams("IDENTITY_MISMATCH", "插件 id 不匹配: "+id)
		}
		if version != pluginVersion {
			return nil, errParams("IDENTITY_MISMATCH", "插件版本不匹配: "+version)
		}
	}
	logf("initialize accepted")
	return map[string]any{
		"protocolVersion": protocolVersion,
		"capabilities":    []string{"connections", "filesystem"},
		"plugin": map[string]any{
			"id":      pluginID,
			"version": pluginVersion,
		},
	}, nil
}

// ------------------------------------------------------------ connection ----

func vaultFromParams(p rawParams) (*Vault, *rpcError) {
	c := p.conn()

	vaultPath := ""
	if s, ok := c.lookupStr("vault_path"); ok {
		vaultPath = s
	}
	root, rerr := expandVaultPath(vaultPath)
	if rerr != nil {
		return nil, rerr
	}

	assetsDir := defaultAssetsDir
	if s, ok := c.lookupStr("assets_dir"); ok {
		if clean, cerr := cleanRelPath(s); cerr == nil {
			assetsDir = clean
		}
	}

	trashEnabled := true
	if b, ok := c.lookupBool("trash_enabled"); ok {
		trashEnabled = b
	}
	return newVault(root, assetsDir, trashEnabled), nil
}

func (s *server) connectionTest(p rawParams) (any, *rpcError) {
	v, rerr := vaultFromParams(p)
	if rerr != nil {
		return nil, rerr
	}
	st, err := os.Stat(v.Root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, errRuntime("VAULT_NOT_FOUND", "笔记库目录不存在: "+v.Root)
		}
		return nil, errRuntime("IO_ERROR", "无法访问笔记库: "+err.Error())
	}
	if !st.IsDir() {
		return nil, errRuntime("VAULT_NOT_DIR", "笔记库路径不是目录: "+v.Root)
	}
	if _, err := os.ReadDir(v.Root); err != nil {
		return nil, errRuntime("IO_ERROR", "笔记库不可读: "+err.Error())
	}
	if err := probeWritable(v.Root); err != nil {
		return nil, errRuntime("IO_ERROR", "笔记库不可写: "+err.Error())
	}
	notes := v.countNotes("")
	return map[string]any{
		"success": true,
		"message": fmt.Sprintf("笔记库可用，共 %d 篇笔记", notes),
		"vault": map[string]any{
			"path":      v.Root,
			"exists":    true,
			"noteCount": notes,
		},
	}, nil
}

func (s *server) connectionConnect(p rawParams) (any, *rpcError) {
	v, rerr := vaultFromParams(p)
	if rerr != nil {
		return nil, rerr
	}
	st, err := os.Stat(v.Root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, errRuntime("VAULT_NOT_FOUND", "笔记库目录不存在: "+v.Root)
		}
		return nil, errRuntime("IO_ERROR", "无法访问笔记库: "+err.Error())
	}
	if !st.IsDir() {
		return nil, errRuntime("VAULT_NOT_DIR", "笔记库路径不是目录: "+v.Root)
	}

	id := p.str("connectionId")
	if id == "" {
		id = p.conn().id
	}
	if id == "" {
		// Anonymous connection: still register under a stable synthetic key so a
		// single-session host keeps working.
		id = "default"
	}
	s.mu.Lock()
	s.sessions[id] = v
	s.mu.Unlock()
	logf("connected session %q vault=%s", id, v.Root)

	return map[string]any{
		"success": true,
		"vault": map[string]any{
			"path":        v.Root,
			"name":        v.Name,
			"noteCount":   v.countNotes(""),
			"folderCount": v.countFolders(),
		},
	}, nil
}

func (s *server) connectionDisconnect(p rawParams) (any, *rpcError) {
	id := p.str("connectionId")
	if id == "" {
		id = p.conn().id
	}
	s.mu.Lock()
	delete(s.sessions, id)
	s.mu.Unlock()
	return map[string]any{"success": true}, nil
}

func (s *server) connectionAction(p rawParams) (any, *rpcError) {
	action := p.object("action")
	actionID := ""
	if action != nil {
		actionID, _ = rawToString(action["id"])
	}
	if actionID == "" {
		actionID = p.str("actionId")
	}
	if actionID != "create-vault" {
		return nil, errRuntime("UNSUPPORTED", "不支持的动作: "+actionID)
	}

	c := p.conn()
	vaultPath := ""
	if s, ok := c.lookupStr("vault_path"); ok {
		vaultPath = s
	}
	root, rerr := expandVaultPath(vaultPath)
	if rerr != nil {
		return nil, rerr
	}

	created := false
	if st, err := os.Stat(root); err != nil {
		if !os.IsNotExist(err) {
			return nil, errRuntime("IO_ERROR", "无法访问路径: "+err.Error())
		}
		if err := os.MkdirAll(root, 0o755); err != nil {
			return nil, errRuntime("IO_ERROR", "创建笔记库失败: "+err.Error())
		}
		created = true
	} else if !st.IsDir() {
		return nil, errRuntime("VAULT_NOT_DIR", "笔记库路径不是目录: "+root)
	}

	readmePath := filepath.Join(root, "README.md")
	if _, err := os.Stat(readmePath); os.IsNotExist(err) {
		body := fmt.Sprintf("# %s\n\n这是 MIKO.MD 笔记库：`%s`\n\n- 每个 `.md` 文件是一篇笔记\n- 每个子目录是一个文件夹\n- 粘贴或拖入的图片默认存放在 `_assets/`\n", filepath.Base(root), root)
		if werr := writeFileAtomic(readmePath, []byte(body)); werr != nil {
			logf("write README.md: %v", werr)
		}
	}

	message := "笔记库已就绪: " + root
	if created {
		message = "已创建笔记库: " + root
	}
	return map[string]any{
		"success": true,
		"message": message,
		"fieldValues": map[string]any{
			"vault_path": root,
		},
	}, nil
}

// --------------------------------------------------------------- helpers ----

func nowStamp() string {
	return time.Now().Format("20060102-150405")
}

func randHex(n int) string {
	buf := make([]byte, (n+1)/2)
	if _, err := rand.Read(buf); err != nil {
		logf("crypto/rand failed, falling back: %v", err)
		return fmt.Sprintf("%016x", uint64(time.Now().UnixNano()))[:n]
	}
	return hex.EncodeToString(buf)[:n]
}

func encodeBase64(data []byte) string {
	return base64.StdEncoding.EncodeToString(data)
}

// decodeBase64 accepts standard, raw and URL-safe alphabets, tolerates a
// data: URL prefix and embedded newlines, and treats an empty payload as an
// empty file rather than an error.
func decodeBase64(s string) ([]byte, *rpcError) {
	trimmed := strings.TrimSpace(s)
	if i := strings.Index(trimmed, ";base64,"); i >= 0 && strings.HasPrefix(trimmed, "data:") {
		trimmed = trimmed[i+len(";base64,"):]
	}
	trimmed = strings.ReplaceAll(trimmed, "\n", "")
	trimmed = strings.ReplaceAll(trimmed, "\r", "")
	trimmed = strings.ReplaceAll(trimmed, " ", "")
	if trimmed == "" {
		return []byte{}, nil
	}
	encodings := []*base64.Encoding{
		base64.StdEncoding,
		base64.RawStdEncoding,
		base64.URLEncoding,
		base64.RawURLEncoding,
	}
	var lastErr error
	for _, enc := range encodings {
		if out, err := enc.DecodeString(trimmed); err == nil {
			return out, nil
		} else {
			lastErr = err
		}
	}
	return nil, errParams("PATH_INVALID", "base64 数据非法: "+lastErr.Error())
}

func clampInt64(v, lo, hi int64) int64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
