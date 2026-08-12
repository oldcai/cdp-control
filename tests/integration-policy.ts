/** CI 显式开启后，无浏览器不允许被 node:test 当作成功的 skip。 */
export function browserRequired(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.CDP_INTEGRATION_REQUIRE_BROWSER === '1';
}
