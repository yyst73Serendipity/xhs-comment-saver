/**
 * 封装 AI API 主机权限检查和按需申请，便于运行时复核与单元测试。
 */
(() => {
  /** 创建只依赖 Chrome permissions 与配置核心的权限控制器。 */
  function createPermissionController({ permissions, core }) {
    function permissionFor(baseUrl) {
      return core.createHostPermissionPattern(baseUrl);
    }

    async function has(baseUrl) {
      return permissions.contains({ origins: [permissionFor(baseUrl)] });
    }

    async function request(baseUrl) {
      const origins = [permissionFor(baseUrl)];
      if (await permissions.contains({ origins })) return true;
      return permissions.request({ origins });
    }

    return Object.freeze({ has, request });
  }

  globalThis.XHS_API_PERMISSION = Object.freeze({ createPermissionController });
})();
