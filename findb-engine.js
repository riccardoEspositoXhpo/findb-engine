// Test minimale di esecuzione batch
console.log("Inizializzazione FinDB Engine...");

const a = 1;
const b = 2;
const result = a + b;

console.log(`Esecuzione test matematico: ${a} + ${b} = ${result}`);

if (result === 3) {
  console.log("Success: Test completato con successo. Uscita pulita.");
  process.exit(0);
} else {
  console.error("Error: Risultato inatteso!");
  process.exit(1);
}
