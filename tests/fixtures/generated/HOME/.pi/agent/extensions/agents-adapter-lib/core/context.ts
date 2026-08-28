/**
 * PolicyContext: ข้อมูลเฉพาะเครื่องที่ classifier ต้องใช้
 * สร้างจาก user config + policy/*.yaml ผ่าน buildContext() ใน policy-loader.ts
 * รูปแบบเดียวกันนี้ถูก serialize เป็น JSON ให้ Python hook (Codex) และ Pi extension ใช้
 */
export interface PolicyContext {
  home: string;
  tmpdir: string;
  cwd: string;
  developmentRoots: string[];
  protectedBranches: string[];
  devEnvPatterns: string[];
  prodEnvPatterns: string[];
  credentialPaths: string[];
  credentialBasenames: string[];
  credentialExtensions: string[];
  systemConfigPaths: string[];
  alwaysWritable: string[];
  agentConfigDirs: string[];
  /** resolve symlink; inject ได้ใน test */
  realpath?: (p: string) => string;
}
