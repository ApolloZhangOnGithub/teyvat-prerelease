// naming → pi naming compatibility layer
// Ambient module declarations allow naming conventions (messageDescription,
// messageType, label) to coexist alongside pi types. The codebase was
// written with these conventions and is NOT expected to match the pi SDK
// types exactly at compile time — runtime mapping handles the translation.

// =========================================================================
// @mariozechner/pi-coding-agent — ambient module with extensions
// =========================================================================
declare module "@mariozechner/pi-coding-agent" {
  // Re-export all the types actually imported by source code
  export type ExtensionAPI = any;
  export type ExtensionContext = any;
  export type ExtensionContextActions = any;
  export type AgentToolUpdateCallback<T = any> = (update: T) => void;
  export type AgentToolResult<T = any> = { content: { type: string; text: string }[]; details?: T };
  export type ExtensionCommandContext = any;
  export type ExtensionCommandContextActions = any;
  export type MessageRenderer = any;
  export type MessageRenderOptions = any;

  // Tool definitions — accept naming (messageDescription, label)
  // alongside standard pi naming (description)
  export interface ToolDefinition<
    TSchema = any,
    TOutput = any,
    TUpdate = any,
    TToolCallId = string,
    TSignal = AbortSignal,
    TCtx = any,
  > {
    name: string;
    description?: string;
    /** convention: same as description */
    messageDescription?: string;
    /** convention: unique label identifier */
    label?: string;
    promptSnippet?: string;
    parameters: TSchema;
    execute(
      toolCallId: TToolCallId,
      params: any,
      signal?: TSignal,
      onUpdate?: AgentToolUpdateCallback<TUpdate>,
      ctx?: TCtx,
    ): Promise<AgentToolResult<TOutput>>;
    renderCall?(args: any, theme: any, ctx?: any): any;
    renderResult?(args: any, theme: any): any;
  }

  export interface ToolInfo {
    name: string;
    description?: string;
    messageDescription?: string;
    label?: string;
    promptSnippet?: string;
    parameters?: any;
  }

  export interface RegisteredCommand {
    name: string;
    description?: string;
    messageDescription?: string;
    label?: string;
    sourceInfo?: any;
    handler?: any;
    promptSnippet?: string;
    parameters?: any;
    execute?: any;
  }

  export interface RegisteredTool extends ToolInfo {}

  export interface CustomMessage<T = unknown> {
    role: "custom";
    /** pi convention: custom message type */
    customType: string;
    /** convention: same as customType */
    messageType?: string;
    content: string | { type: string; text?: string; [key: string]: any }[];
    /** pi convention: whether to display in TUI */
    display: boolean;
    /** convention: same as display */
    isDisplayedInTUI?: boolean;
    details?: T;
    timestamp: number;
  }

  export interface SendMessageOptions {
    /** pi convention: whether to trigger a new turn */
    triggerTurn?: boolean;
    /** convention: same as triggerTurn */
    isTriggerNewTurn?: boolean;
  }

  // Functions imported by
  export function getMarkdownTheme(): any;
  export function isBashToolResult(event: any): boolean;
  export function isToolCallEventType(toolName: string, event: any): boolean;
}

// =========================================================================
// global runtime variables (augment globalThis)
// =========================================================================
declare global {
  var __PersonId: string;
  var __PersonName: string;
  var __PersonDir: string;
  var __RuntimeDir: string;
  var __ChannelDir: string;
  var __SessionDir: string;
  var __AgentFileDir: string;
  var __ls_dir: string;
  // pi-runtime globals set by
  var __piAbort: (() => void) | undefined;
  var __piRecapPending: boolean | undefined;
  var __piWatcher: any;
  var __piEscJustPressed: boolean | undefined;
  var __notificationPush: ((message: any) => void) | undefined;
}
