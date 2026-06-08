// Project/App: gsd-pi
// File Purpose: Shared parsing and formatting helpers for MCP-scoped tool names.

const MCP_TOOL_PREFIX = "mcp__";

export interface ParsedMcpToolName {
  serverName: string;
  toolName: string;
}

export function parseMcpToolName(toolName: string): ParsedMcpToolName | null {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return null;
  const toolSeparator = toolName.indexOf("__", MCP_TOOL_PREFIX.length);
  if (toolSeparator < 0) return null;
  return {
    serverName: toolName.slice(MCP_TOOL_PREFIX.length, toolSeparator),
    toolName: toolName.slice(toolSeparator + 2),
  };
}

export function stripMcpToolPrefix(toolName: string): string {
  return parseMcpToolName(toolName)?.toolName ?? toolName;
}

export function toMcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}__${toolName}`;
}

export function toMcpWildcardToolName(serverName: string): string {
  return toMcpToolName(serverName, "*");
}

export function mcpToolMatchesBaseName(toolName: string, baseName: string): boolean {
  return parseMcpToolName(toolName)?.toolName === baseName;
}
