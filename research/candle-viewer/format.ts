/** Standard OHLCV price display precision (DOGE and sub-$2 pairs need 6dp). */
export const PRICE_DECIMAL_PLACES = 6;

export const PRICE_MIN_MOVE = 10 ** -PRICE_DECIMAL_PLACES;

export function formatPrice(value: number): string {
	return value.toLocaleString(undefined, {
		minimumFractionDigits: PRICE_DECIMAL_PLACES,
		maximumFractionDigits: PRICE_DECIMAL_PLACES,
	});
}

export function chartPriceFormat(): {
	type: "price";
	precision: number;
	minMove: number;
} {
	return {
		type: "price",
		precision: PRICE_DECIMAL_PLACES,
		minMove: PRICE_MIN_MOVE,
	};
}
