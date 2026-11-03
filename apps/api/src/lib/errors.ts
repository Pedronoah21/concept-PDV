export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'ERRO',
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, code = 'DADOS_INVALIDOS') => new AppError(400, msg, code);
export const forbidden = (msg = 'Sem permissão para esta ação', code = 'SEM_PERMISSAO') => new AppError(403, msg, code);
export const notFound = (what = 'Registro') => new AppError(404, `${what} não encontrado`, 'NAO_ENCONTRADO');
export const conflict = (msg: string, code = 'CONFLITO') => new AppError(409, msg, code);
