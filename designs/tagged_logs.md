# Tagged LLM Logging Design

## Problem Statement

Current LLM call logging uses timestamp-based filenames which makes it difficult to:
- Track calls within a specific conversation
- Identify which agent made a call
- Follow the sequence of turns in a conversation
- Debug scenario creation workflows
- Audit tool synthesis pipelines

## Solution: Metadata-Based Log Organization

### Core Concept

Allow clients to pass `loggingMetadata` when calling LLM endpoints, which will be used to create organized, hierarchical log directories that reflect the context of each call.

### Log File Naming Patterns

#### 1. Conversation Context
```
<logdir>/conversation_<conversation_id>/<timestamp>_turn_<turn_number>_<agent_name>_<step_descriptor>/
```
Each directory contains:
- `request.txt` - The request messages
- `response.txt` - The LLM response

Note: Timestamp comes first for chronological sorting within the conversation folder.

Example:
```
/data/llm-debug/conversation_42/2025-01-17T10-30-45_turn_003_assistant_initial/
├── request.txt
└── response.txt
```

#### 2. Scenario Editor Context
```
<logdir>/scenario_editor/<timestamp>_<scenario_id>_<step_descriptor>/
```
Note: Uses flat structure like conversations - timestamp first for chronological sorting

Example:
```
/data/llm-debug/scenario_editor/2025-01-17T09-00-00_weather-app_create_initial/
├── request.txt
└── response.txt
```

#### 3. Tool Synthesis Context (within conversation)
```
<logdir>/conversation_<conversation_id>/<timestamp>_tool_synthesis_<tool_name>/
```
Example:
```
/data/llm-debug/conversation_abc123/2025-01-17T10-02-00_tool_synthesis_synthesize_search_weather/
├── request.txt
└── response.txt
```

### LoggingMetadata Interface

```typescript
interface LoggingMetadata {
  // Conversation context
  conversationId?: number | string;
  agentName?: string;
  turnNumber?: number;
  stepDescriptor?: string;  // e.g., "initial_response", "tool_call", "followup"
  
  // Scenario context
  scenarioId?: string;
  
  // Tool synthesis context
  toolName?: string;
  
  // General context
  context?: 'conversation' | 'scenario_editor' | 'tool_synthesis' | 'other';
  customPrefix?: string;  // For special cases
}
```

### Implementation Strategy

#### Phase 1: Core Infrastructure
1. **Update LLM endpoint schema** to accept optional `loggingMetadata`
2. **Create log path builder** function that generates appropriate paths based on metadata
3. **Ensure directory creation** for nested log structures
4. **Backward compatibility** - if no metadata provided, use current timestamp-based naming

#### Phase 2: Integration Points
1. **Scenario-driven-agent**
   - Pass conversationId, agentName, turnNumber on each LLM call
   - Include stepDescriptor for different phases (initial, tool_call, synthesis)

2. **Tool synthesis pipeline**
   - Include conversationId, agentName, toolName
   - Mark as tool_synthesis context

3. **Scenario editor**
   - Pass scenarioId when generating/editing scenarios
   - Mark as scenario_editor context

#### Phase 3: Additional Features
1. **Log rotation and cleanup**
   - Implement policies for old conversation logs
   - Archive completed conversations

2. **Log indexing**
   - Create index files per conversation for quick navigation
   - Generate summary metadata files

3. **Debug UI integration**
   - Link from conversation view to relevant logs
   - Show log file paths in debug panels

### File Structure Example

```
logs/
├── conversation_42/
│   ├── 2025-01-17T10-00-00_turn_001_primary_care_agent_initial/
│   │   ├── request.txt
│   │   └── response.txt
│   ├── 2025-01-17T10-00-15_turn_001_primary_care_agent_step_1/
│   │   ├── request.txt
│   │   └── response.txt
│   ├── 2025-01-17T10-00-30_tool_synthesis_synthesize_searchGuidelines/
│   │   ├── request.txt
│   │   └── response.txt
│   └── 2025-01-17T10-01-00_turn_002_payer_agent_response/
│       ├── request.txt
│       └── response.txt
├── conversation_43/
│   └── ...
└── scenario_editor/
    ├── 2025-01-17T09-00-00_knee_mri_scenario_create/
    │   ├── request.txt
    │   └── response.txt
    └── 2025-01-17T09-15-00_diabetes_tech_scenario_update/
        ├── request.txt
        └── response.txt
```

Note: Within conversation folders, timestamps appear first to ensure chronological ordering when listing files.

### Benefits

1. **Improved Debugging**
   - Easy to find all LLM calls for a specific conversation
   - Clear sequence of turns and agents
   - Identifiable context for each call

2. **Better Auditing**
   - Track LLM usage per conversation
   - Analyze patterns by agent or scenario
   - Monitor tool synthesis effectiveness

3. **Performance Analysis**
   - Compare response times across turns
   - Identify slow agents or tools
   - Track token usage patterns

4. **Development Workflow**
   - Quickly locate relevant logs during debugging
   - Share specific conversation logs with team
   - Reproduce issues with clear context

### Migration Path

1. **Phase 1**: Add metadata support without breaking existing code
2. **Phase 2**: Update high-value call sites (scenario-driven-agent)
3. **Phase 3**: Gradually migrate other call sites
4. **Phase 4**: Deprecate timestamp-only naming (with config flag)

### Configuration

```typescript
interface LoggingConfig {
  enabled: boolean;
  basePath: string;
  useMetadataStructure: boolean;  // Feature flag for new structure
  includeRequestBody: boolean;
  includeResponseBody: boolean;
  maxLogAgeDays?: number;  // For automatic cleanup
}
```

### Security Considerations

1. **Sanitize filenames** - ensure metadata doesn't create invalid paths
2. **Limit directory depth** - prevent deeply nested structures
3. **Access control** - ensure logs follow same permissions as main app
4. **PII handling** - consider what gets logged in production

### Testing Strategy

1. **Unit tests** for path generation logic
2. **Integration tests** for full logging flow
3. **Performance tests** for directory creation overhead
4. **Cleanup tests** for log rotation

### Rollout Plan

1. **Week 1**: Implement core infrastructure with feature flag
2. **Week 2**: Update scenario-driven-agent to use metadata
3. **Week 3**: Update tool synthesis and scenario editor
4. **Week 4**: Monitor and optimize based on usage patterns
5. **Week 5**: Enable by default for development environments

### Success Metrics

1. **Developer productivity**: Time to locate relevant logs reduced by 70%
2. **Debug efficiency**: Issue reproduction time reduced by 50%
3. **Storage efficiency**: Easier to identify and clean old logs
4. **Audit completeness**: 100% of conversation LLM calls traceable