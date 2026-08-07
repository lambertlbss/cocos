export interface FontAssetOption {
    name: string;
    url: string;
    relativePath: string;
}

export function normalizeFontName(value: string): string {
    return value
        .normalize('NFKC')
        .replace(/\.(ttf|otf|fnt|woff2?)$/i, '')
        .replace(/[\s_-]+/g, '')
        .toLocaleLowerCase();
}

export function findFontAsset(
    family: string,
    assets: FontAssetOption[],
): FontAssetOption | undefined {
    const target = normalizeFontName(family);
    if (!target) {
        return undefined;
    }
    return assets.find((asset) => normalizeFontName(asset.name) === target)
        ?? assets.find((asset) => {
            const name = normalizeFontName(asset.name);
            return name.includes(target) || target.includes(name);
        });
}
