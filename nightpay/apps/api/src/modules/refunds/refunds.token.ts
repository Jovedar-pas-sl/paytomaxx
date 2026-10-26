/**
 * Nombre con el que RefundsService también se puede pedir a ModuleRef. El saldo
 * (WalletChargesService) lo usa para devolver a la tarjeta sin importar la clase:
 * importarla cerraría el ciclo Wallets → Refunds → Payments → Wallets. Una cadena
 * suelta no basta: Nest registra el servicio por su clase, y por eso «Devolver
 * saldo → A su tarjeta» daba 500 («could not find RefundsService element»).
 */
export const REFUNDS_SERVICE = 'RefundsService';
