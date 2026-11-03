export interface GrammarIssue { start: number; end: number; message: string; replacement?: string }
export interface GrammarChecker { check(text: string): Promise<GrammarIssue[]> }
export const emptyGrammarChecker: GrammarChecker = { async check(_text) { return []; } };
