import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";

type GrammarLanguage = Parameters<Parser["setLanguage"]>[0];

export interface Chunk {
  text: string;
  filePath: string;
  repo: string;
  startLine: number;
  endLine: number;
  chunkIndex: number;
  totalChunks: number;
  language: string;
  symbolName: string | null;
  symbolType: string | null;
  commitHash: string;
}

const MAX_LINES = 200;
const OVERLAP_LINES = 20;

const TARGET_NODE_TYPES = [
  "function_declaration",
  "class_declaration",
  "method_definition",
  "interface_declaration",
  "type_alias_declaration",
  "lexical_declaration",
];

interface RawRange {
  startLine: number;
  endLine: number;
  symbolName: string | null;
  symbolType: string | null;
}

function extractSymbolName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  if (nameNode) return nameNode.text;

  if (node.type === "lexical_declaration") {
    const declarator = node.children.find(
      (c) => c.type === "variable_declarator",
    );
    if (declarator) {
      const ident = declarator.childForFieldName("name");
      if (ident) return ident.text;
    }
  }

  for (const child of node.children) {
    if (
      child.type === "type_identifier" ||
      child.type === "identifier" ||
      child.type === "property_identifier"
    ) {
      return child.text;
    }
  }

  return null;
}

function determineSymbolType(
  node: Parser.SyntaxNode,
): string | null {
  switch (node.type) {
    case "function_declaration":
      return "function";
    case "class_declaration":
      return "class";
    case "method_definition":
      return "method";
    case "interface_declaration":
      return "interface";
    case "type_alias_declaration":
      return "type";
    case "lexical_declaration": {
      const declarator = node.children.find(
        (c) => c.type === "variable_declarator",
      );
      if (declarator) {
        const value = declarator.childForFieldName("value");
        if (value?.type === "arrow_function") return "component";
      }
      return null;
    }
    default:
      return null;
  }
}

function isInsideScope(node: Parser.SyntaxNode): boolean {
  let parent = node.parent;
  while (parent) {
    const t = parent.type;
    if (
      t === "statement_block" ||
      t === "class_body" ||
      t === "interface_body" ||
      t === "for_statement" ||
      t === "for_in_statement" ||
      t === "while_statement" ||
      t === "if_statement" ||
      t === "try_statement" ||
      t === "catch_clause" ||
      t === "switch_body"
    ) {
      return true;
    }
    if (t === "program" || t === "export_statement") {
      return false;
    }
    parent = parent.parent;
  }
  return false;
}

function collectRanges(
  root: Parser.SyntaxNode,
  source: string,
): RawRange[] {
  const nodes = root.descendantsOfType(TARGET_NODE_TYPES);
  const ranges: RawRange[] = [];

  for (const node of nodes) {
    const lineCount =
      node.endPosition.row - node.startPosition.row + 1;
    const symbolType = determineSymbolType(node);

    if (node.type === "lexical_declaration") {
      if (isInsideScope(node)) continue;
      if (symbolType === null && lineCount < 3) continue;
    }

    let startLine = node.startPosition.row + 1;
    let endLine = node.endPosition.row + 1;

    if (node.parent?.type === "export_statement") {
      startLine = node.parent.startPosition.row + 1;
      endLine = node.parent.endPosition.row + 1;
    }

    ranges.push({
      startLine,
      endLine,
      symbolName: extractSymbolName(node),
      symbolType,
    });
  }

  return ranges;
}

function deduplicateRanges(ranges: RawRange[]): RawRange[] {
  if (ranges.length <= 1) return ranges;

  ranges.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

  const result: RawRange[] = [];
  for (const range of ranges) {
    const prev = result[result.length - 1];
    if (
      prev &&
      prev.startLine === range.startLine &&
      prev.endLine === range.endLine
    ) {
      if (!prev.symbolName && range.symbolName) {
        result[result.length - 1] = range;
      }
      continue;
    }
    result.push(range);
  }

  return result;
}

function splitLargeRanges(ranges: RawRange[]): RawRange[] {
  const result: RawRange[] = [];

  for (const range of ranges) {
    const lineCount = range.endLine - range.startLine + 1;
    if (lineCount <= MAX_LINES) {
      result.push(range);
      continue;
    }

    let start = range.startLine;
    let chunkIdx = 0;
    while (start <= range.endLine) {
      const end = Math.min(start + MAX_LINES - 1, range.endLine);
      result.push({
        startLine: start,
        endLine: end,
        symbolName: chunkIdx === 0 ? range.symbolName : null,
        symbolType: chunkIdx === 0 ? range.symbolType : null,
      });
      if (end >= range.endLine) break;
      start = end - OVERLAP_LINES + 1;
      chunkIdx++;
    }
  }

  return result;
}

export function parseTsFile(
  source: string,
  filePath: string,
  repo: string,
  commitHash: string,
): Chunk[] {
  try {
    const parser = new Parser();
    const grammar = filePath.endsWith(".tsx")
      ? (TypeScript.tsx as GrammarLanguage)
      : (TypeScript.typescript as GrammarLanguage);
    parser.setLanguage(grammar);

    const tree = parser.parse(source);
    if (!tree) return [];

    const lines = source.split("\n");
    let ranges = collectRanges(tree.rootNode, source);
    ranges = deduplicateRanges(ranges);
    ranges = splitLargeRanges(ranges);

    const language = filePath.endsWith(".tsx") ? "tsx" : "typescript";

    return ranges.map((range, index) => {
      const codeLines = lines.slice(range.startLine - 1, range.endLine);
      const codeText = codeLines.join("\n");

      return {
        text: codeText,
        filePath,
        repo,
        startLine: range.startLine,
        endLine: range.endLine,
        chunkIndex: index,
        totalChunks: ranges.length,
        language,
        symbolName: range.symbolName,
        symbolType: range.symbolType,
        commitHash,
      };
    });
  } catch (err) {
    console.error(`[chunker] Failed to parse ${filePath}:`, err);
    return [];
  }
}