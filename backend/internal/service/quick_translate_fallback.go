package service

// 无执行计划时的回退路径：让「暂无可用执行计划」不再阻断即时翻译。
//
// 语义约定：
//   - 执行计划存在时，翻译轮次完全由用户配置的执行计划决定；
//   - 执行计划缺失（请求未带 execution_plan_id，或账号下没有任何计划）时，
//     后端用「当前账号可用的默认 AI 后端 + 内置翻译提示词模板 + 内置执行策略」
//     构造一个只含单轮 translate 的快照，直接完成本次文本处理；
//   - 两条路径的授权语义一致：有项目按项目归属方校验后端，无项目按 actor 身份校验。

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/MeowSalty/LinguaFlow/backend/internal/ent"
	"github.com/MeowSalty/LinguaFlow/backend/internal/ent/backend"
	"github.com/MeowSalty/LinguaFlow/backend/internal/execution"
	"github.com/MeowSalty/LinguaFlow/backend/internal/prompt"
	"github.com/MeowSalty/LinguaFlow/backend/internal/templates"
)

const (
	// DefaultQuickTranslatePlanName 是回退快照在轮次概览与审计里的展示名。
	DefaultQuickTranslatePlanName = "默认快速处理"
	// defaultQuickTranslateBatchSize 单段即时翻译按段处理，不做多段合批。
	defaultQuickTranslateBatchSize = 1
	// defaultQuickTranslateConcurrency 单段文本无需并发。
	defaultQuickTranslateConcurrency = 1
	// defaultQuickTranslateFallbackShrink 与内置默认执行计划保持一致。
	defaultQuickTranslateFallbackShrink = 0.5
	// defaultQuickTranslateRetryAttempts 回退路径的重试次数（比计划路径更保守）。
	defaultQuickTranslateRetryAttempts = 2
	// defaultQuickTranslateRetryBackoffMS 回退路径的重试退避。
	defaultQuickTranslateRetryBackoffMS = 1000
)

// quickTranslatePlanLabel 返回执行计划在审计/用量备注里的可读标识。
// 未指定计划（回退路径）时返回 default。
func quickTranslatePlanLabel(executionPlanID int) string {
	if executionPlanID <= 0 {
		return "default"
	}
	return fmt.Sprintf("%d", executionPlanID)
}

// prepareDefaultExecutionSnapshotForActor 在未指定执行计划时构造默认执行快照：
// 选出 actor（或项目归属方）可访问且凭据可用的默认 AI 后端，配合内置翻译提示词
// 模板与内置执行策略，只跑一轮 translate。
//
// 与 prepareExecutionSnapshotForActor 的唯一差别是轮次来源：前者来自用户配置的
// 执行计划模板，后者来自内置默认资产；授权与快照冻结语义保持一致。
func (s *JobService) prepareDefaultExecutionSnapshotForActor(
	ctx context.Context,
	actorUserID int,
	sourceLang, targetLang string,
	glossaryEnabled bool,
	projectRow *ent.Project,
) (*JobExecutionSnapshot, func(), error) {
	ctx, leases := withExecutionLeases(ctx)
	successful := false
	defer func() {
		if !successful {
			leases.release()
		}
	}()

	backendSnap, err := s.defaultBackendSnapshot(ctx, actorUserID, projectRow)
	if err != nil {
		return nil, nil, err
	}

	promptSnap, err := s.snapshotPromptTemplate(ctx, actorUserID, templates.BuiltinTranslationPromptTemplateID)
	if err != nil {
		return nil, nil, fmt.Errorf("default translation prompt: %w", err)
	}
	if strings.TrimSpace(promptSnap.Content) == "" {
		return nil, nil, errors.New("default translation prompt template has no system_prompt_content")
	}

	strategySnap, err := s.snapshotProfile(ctx, actorUserID, templates.BuiltinExecutionProfileID)
	if err != nil {
		return nil, nil, fmt.Errorf("default strategy profile: %w", err)
	}

	snapshot := &JobExecutionSnapshot{
		SchemaVersion:            execution.SnapshotSchemaVersion,
		DefaultsVersion:          execution.SnapshotDefaultsVersion,
		RubyProtocolVersion:      execution.RubyProtocolVersion,
		RubyValidatorVersion:     execution.RubyValidatorVersion,
		RubyBatchProtocolVersion: execution.RubyBatchProtocolVersion,
		RubyTemplates: execution.RubyTemplates{
			JSON:      prompt.RubyAlignmentJSONTemplate,
			Text:      prompt.RubyAlignmentTextTemplate,
			BatchJSON: prompt.RubyAlignmentBatchJSONTemplate,
			BatchText: prompt.RubyAlignmentBatchTextTemplate,
		},
		ExecutionPlanID:   0,
		ExecutionPlanName: DefaultQuickTranslatePlanName,
		Strategy:          *strategySnap,
		Rounds: []JobRoundSnapshot{{
			Mode:    "translate",
			Backend: *backendSnap,
			Translate: &JobTranslateRoundSnapshot{
				Prompt:           *promptSnap,
				BatchSize:        defaultQuickTranslateBatchSize,
				MaxWordsPerBatch: 0,
				Concurrency:      defaultQuickTranslateConcurrency,
				FallbackShrink:   defaultQuickTranslateFallbackShrink,
				// 单段即时翻译没有段落状态可言，段过滤器固定为 all。
				SegmentFilter: &SegmentFilterSnapshot{StatusFilter: "all"},
				Retry: execution.RetryConfig{
					MaxAttempts: defaultQuickTranslateRetryAttempts,
					BackoffMs:   defaultQuickTranslateRetryBackoffMS,
				},
			},
		}},
	}
	snapshot.SourceLang = sourceLang
	snapshot.TargetLang = targetLang
	snapshot.GlossaryEnabled = glossaryEnabled

	resolved, err := execution.Resolve(*snapshot)
	if err != nil {
		return nil, nil, err
	}
	successful = true
	return resolved, leases.release, nil
}

// defaultBackendSnapshot 选出可用于默认执行的 AI 后端并冻结其快照。
// 候选按 ID 升序遍历：个人后端在前、组织共享后端在后；跳过无权限或凭据不可用的项。
func (s *JobService) defaultBackendSnapshot(
	ctx context.Context,
	actorUserID int,
	projectRow *ent.Project,
) (*BackendSnapshot, error) {
	candidates, err := s.defaultBackendCandidates(ctx, actorUserID, projectRow)
	if err != nil {
		return nil, err
	}
	for _, backendID := range candidates {
		if projectRow != nil {
			if err := s.validateBackendAccess(ctx, projectRow, backendID); err != nil {
				continue
			}
		} else if err := s.validateBackendAccessForActor(ctx, actorUserID, backendID); err != nil {
			continue
		}
		snap, err := s.snapshotBackend(ctx, backendID)
		if err != nil {
			// 凭据缺失/被吊销的后端直接跳过，继续尝试下一个候选。
			slog.Warn("quick translate: default backend unusable", "backend_id", backendID, "err", err)
			continue
		}
		return snap, nil
	}
	return nil, ErrQuickTranslateNoBackend
}

// defaultBackendCandidates 列出默认执行的后端候选（按 ID 升序）。
// 无项目时：actor 的个人后端 + actor 以管理员身份所在的组织共享后端；
// 有项目时：项目归属方（用户或组织）可访问的后端。
func (s *JobService) defaultBackendCandidates(
	ctx context.Context,
	actorUserID int,
	projectRow *ent.Project,
) ([]int, error) {
	rows, err := s.client.Backend.Query().Order(ent.Asc(backend.FieldID)).All(ctx)
	if err != nil {
		return nil, fmt.Errorf("list backends: %w", err)
	}
	out := make([]int, 0, len(rows))
	for _, row := range rows {
		if projectRow != nil {
			// 项目维度：沿用项目级后端鉴权语义（归属方决定可见范围）。
			if err := s.validateBackendAccess(ctx, projectRow, row.ID); err != nil {
				continue
			}
			out = append(out, row.ID)
			continue
		}
		switch row.Scope {
		case ScopeUser:
			if row.OwnerUserID != nil && *row.OwnerUserID == actorUserID {
				out = append(out, row.ID)
			}
		case ScopeOrg:
			if row.OwnerOrgID == nil {
				continue
			}
			if _, err := s.backends.requireOwnership(ctx, actorUserID, row.ID); err != nil {
				continue
			}
			out = append(out, row.ID)
		}
	}
	return out, nil
}

// applyQuickTranslateInstructions 把场景/语气意图追加到翻译轮次的系统提示词末尾。
//
// 提示词正文是 Go text/template，因此先把指令中的 {{ }} 转义成模板字面量，
// 避免客户端传入的文本被当作模板动作解析（解析失败会让整轮翻译报错）。
func applyQuickTranslateInstructions(snapshot *JobExecutionSnapshot, instructions string) {
	instructions = strings.TrimSpace(instructions)
	if instructions == "" || snapshot == nil {
		return
	}
	hint := escapeTemplateDelimiters(instructions)
	for i := range snapshot.Rounds {
		round := &snapshot.Rounds[i]
		if round.Mode != "translate" || round.Translate == nil {
			continue
		}
		round.Translate.Prompt.Content = strings.TrimRight(round.Translate.Prompt.Content, "\n") +
			"\n\n【本次处理意图】\n" + hint + "\n"
	}
}

// escapeTemplateDelimiters 把文本中的模板定界符转义为字面量输出。
// strings.Replacer 单次扫描不会重新扫描替换结果，因此 {{ 与 }} 互不干扰。
func escapeTemplateDelimiters(text string) string {
	return strings.NewReplacer(
		"{{", `{{"{{"}}`,
		"}}", `{{"}}"}}`,
	).Replace(text)
}
