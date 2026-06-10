import jwt from 'jsonwebtoken';

export interface TokenPayload {
  sub: string;
  tables?: string[];
  permissions?: 'read' | 'write' | 'readwrite';
  [key: string]: any;
}

export class AuthManager {
  constructor(
    private secret: string,
    private tokenExpiry: string = '24h'
  ) {}

  /**
   * 簽章產生 JWT Token
   */
  generateToken(payload: TokenPayload): string {
    return (jwt.sign as any)(payload, this.secret, { expiresIn: this.tokenExpiry });
  }

  /**
   * 驗證 JWT Token，回傳解碼後的 Payload。若無效則丟出錯誤。
   */
  verifyToken(token: string): TokenPayload {
    return jwt.verify(token, this.secret) as TokenPayload;
  }

  /**
   * 檢查 Token 權限是否允許對特定 Table 進行特定讀寫操作
   */
  canAccess(
    payload: TokenPayload,
    tableName: string,
    action: 'read' | 'write'
  ): boolean {
    // 若無 tables 配置，預設允許存取所有 table
    if (payload.tables && !payload.tables.includes(tableName)) {
      return false;
    }

    const permissions = payload.permissions || 'readwrite';
    
    if (action === 'read') {
      return permissions === 'read' || permissions === 'readwrite';
    }
    
    if (action === 'write') {
      return permissions === 'write' || permissions === 'readwrite';
    }

    return false;
  }
}
