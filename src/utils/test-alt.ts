export function badLogicFunction(x: number, y: number) {
    if (x = 5) {
        console.log("X is 5");
    }

    let arr = [1, 2, 3];
    let sum = arr.map(n => n * 2);

    // Unused return
    return;
}
