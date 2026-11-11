package service

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// TestQuickTranslateService_NoExecutionPlan_FallsBackToDefaultBackend 验证：
// 未指定执行计划时不再阻断，而是回退到账号下的默认可用 AI 后端直接完成翻译。
func TestQuickTranslateService_NoExecutionPlan_FallsBackToDefaultBackend(t *testing.T) {
	svc, client, userID, runner := newQuickFixture(t)
	backendID := seedUserBackend(t, client, userID)

	out, err := svc.Translate(context.Background(), QuickTranslateInput{
		ActorUserID: userID,
		SourceText:  "hello",
		// ExecutionPlanID 省略：账号下也没有任何执行计划模板。
	})
	if err != nil {
		t.Fatalf("translate without execution plan: %v", err)
	}
	if out.Status != "success" {
		t.Errorf("status = %q, want success", out.Status)
	}
	if out.TargetText != "译文" {
		t.Errorf("target = %q, want 译文", out.TargetText)
	}
	if !runner.called {
		t.Fatal("runner not called")
	}
	snapshot := runner.captured.Snapshot
	if snapshot == nil {
		t.Fatal("captured snapshot is nil")
	}
	if len(snapshot.Rounds) != 1 {
		t.Fatalf("rounds = %d, want 1 (default single translate round)", len(snapshot.Rounds))
	}
	if snapshot.Rounds[0].Mode != "translate" {
		t.Errorf("round mode = %q, want translate", snapshot.Rounds[0].Mode)
	}
	if snapshot.Rounds[0].Backend.ID != backendID {
		t.Errorf("backend id = %d, want %d (actor's own backend)", snapshot.Rounds[0].Backend.ID, backendID)
	}
	if snapshot.Rounds[0].Translate == nil {
		t.Fatal("translate round config is nil")
	}
	if snapshot.Rounds[0].Translate.Prompt.Content == "" {
		t.Error("translate prompt content is empty")
	}
}

// TestQuickTranslateService_NoExecutionPlan_NoBackend_ReturnsError 验证：
// 账号下没有任何可用后端时，回退路径给出明确错误而不是静默失败。
func TestQuickTranslateService_NoExecutionPlan_NoBackend_ReturnsError(t *testing.T) {
	svc, _, userID, runner := newQuickFixture(t)

	_, err := svc.Translate(context.Background(), QuickTranslateInput{
		ActorUserID: userID,
		SourceText:  "hello",
	})
	if !errors.Is(err, ErrQuickTranslateNoBackend) {
		t.Fatalf("err = %v, want ErrQuickTranslateNoBackend", err)
	}
	if runner.called {
		t.Error("runner must not be called when no backend is available")
	}
}

// TestQuickTranslateService_Instructions_AppendedToPrompt 验证：场景/语气意图
// 会被追加到翻译轮次的系统提示词末尾（外贸场景快捷切换的落点）。
func TestQuickTranslateService_Instructions_AppendedToPrompt(t *testing.T) {
	svc, client, userID, runner := newQuickFixture(t)
	backendID := seedUserBackend(t, client, userID)
	planID := seedTranslatePlan(t, client, userID, backendID)

	_, err := svc.Translate(context.Background(), QuickTranslateInput{
		ActorUserID:     userID,
		SourceText:      "hello",
		ExecutionPlanID: planID,
		Instructions:    "使用正式商务邮件语气，先问候再回应询盘。",
	})
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	content := runner.captured.Snapshot.Rounds[0].Translate.Prompt.Content
	if !strings.Contains(content, "使用正式商务邮件语气，先问候再回应询盘。") {
		t.Errorf("instructions not appended to prompt; content = %q", content)
	}
}

// TestQuickTranslateService_Instructions_EscapedTemplateDelimiters 验证：指令中的
// 模板定界符被转义，不会被当成模板动作解析（否则整轮翻译会报错）。
func TestQuickTranslateService_Instructions_EscapedTemplateDelimiters(t *testing.T) {
	svc, client, userID, runner := newQuickFixture(t)
	seedUserBackend(t, client, userID)

	_, err := svc.Translate(context.Background(), QuickTranslateInput{
		ActorUserID:  userID,
		SourceText:   "hello",
		Instructions: "保持 {{source_lang}} 原样并输出 {{end}}",
	})
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	content := runner.captured.Snapshot.Rounds[0].Translate.Prompt.Content
	if strings.Contains(content, "{{source_lang}}") {
		t.Errorf("template delimiters were not escaped; content = %q", content)
	}
	if !strings.Contains(content, "{{\"{{\"}}") {
		t.Errorf("escaped literal not found in prompt; content = %q", content)
	}
}
