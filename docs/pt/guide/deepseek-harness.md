# DeepSeek Harness

O agent de programação de código aberto oficial da DeepSeek. Corre na sua máquina.

Tem uma interface web, em `localhost:3080`.

Uma interface web significa que o Voyager consegue entrar.

## Porque funciona

O Gestor de Prompts do Voyager não olha para domínios. Olha para os sites que você adicionou.

Um endereço local também é um site.

Por isso o DeepSeek Harness não é diferente do Gemini, do Claude ou do ChatGPT — apenas mais um sítio para onde os seus prompts o acompanham.

## Três passos

### 1. Arranque o DSH

```bash
npm i -g @deepseek-ai/dsh
dsh web
```

Abra `http://localhost:3080` no navegador.

### 2. Ligue o interruptor no popup

![Clique no ícone de puzzle da barra de ferramentas, clique em Voyager e ligue o Gestor de Prompts em localhost:3080](/assets/dsh-enable-steps-en.png)

Como já está em `localhost:3080`, o popup mostra-lhe essa opção logo no topo. Ligue-a e conceda o acesso.

Não é preciso escrever o endereço.

### 3. Atualize a página

O botão flutuante aparece no canto inferior direito.

![Gestor de Prompts dentro do DeepSeek Harness](/assets/prompt-manager-deepseek-harness.png)

## Uma só biblioteca, em todo o lado

Não tem uma biblioteca por cada site. Tem uma só, e ela acompanha-o.

Cada prompt que guardou no Gemini, no Claude ou no ChatGPT já lá está quando abre o DSH. Todos, sem faltar nenhum. E ao contrário também: escreva um prompt dentro do DSH e ele espera por si de volta no Gemini.

As mesmas etiquetas, os mesmos favoritos, a mesma pesquisa.

![Uma só biblioteca a chegar a todas as interfaces](/assets/one-prompt-library.png)

## Algumas notas

**A porta não é fixa.** O DSH ainda é uma pré-visualização para programadores e a porta predefinida pode mudar. Se mudar, basta adicionar a nova.

**Só o Gestor de Prompts é carregado.** A Linha do Tempo, as Pastas e o resto foram feitos para o Gemini e não arrancam num site personalizado.

**Os seus prompts nunca saem da máquina.** O DSH é local, a biblioteca do Voyager é local. Nada na cadeia vai para fora.

::: tip
O mesmo método serve para qualquer interface web local — Open WebUI, LibreChat, a que você mesmo escreveu. Adicione o endereço, atualize, pronto.
:::
