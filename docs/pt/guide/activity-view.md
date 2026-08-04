---
title: Vista Activity
description: Organize as conversas das pastas pela atividade real e mostre primeiro o trabalho que ainda está em curso.
---

# Activity: mantenha a atenção nas conversas em curso

As pastas respondem a uma pergunta: onde pertence esta conversa? À medida que o arquivo cresce, surge outra com mais frequência: o que deve ser visto agora?

Activity é uma vista temporal sobre as pastas. Clique no sino à direita de **Folders** para substituir temporariamente a árvore por conversas ordenadas pela atividade real. A estrutura das pastas, a associação das conversas e o estado Star não são alterados.

**Inspiração do design:** esta vista foi inspirada na barra lateral do Codex / ChatGPT Desktop da OpenAI. O Voyager retoma a ideia de mostrar primeiro as conversas que continuam ativas e adapta-a a uma vista temporal sobre as pastas do Gemini.

<img src="/assets/activity-view.png" alt="Vista Activity na barra lateral do Gemini" style="display: block; width: 100%; max-width: 517px; margin: 24px auto; border-radius: 14px; box-shadow: 0 12px 32px rgba(0,0,0,0.12);"/>

## Prioridade (Priority) acompanha a atividade recente

Prioridade contém conversas com um novo turno nas últimas **três horas**. Usa a hora real da conversa, não a hora em que o chat foi aberto ou consultado.

Uma conversa em Prioridade não aparece também em Hoje. Quando termina o período de atividade de três horas, Activity devolve-a automaticamente a Hoje ou ao grupo de data correspondente. Não é necessário atualizar a página.

Star continua disponível como uma marca manual independente. Adicionar uma Star não move a conversa para Prioridade, e removê-la não retira uma conversa ativa de Prioridade.

## Uma janela curta sobre os últimos dias

Abaixo de Prioridade aparecem Hoje (Today), Ontem (Yesterday) e os dias da semana anteriores. Activity abrange hoje e os quatro dias de calendário anteriores para manter a lista próxima do trabalho atual.

As conversas mais antigas e os registos sem hora de atividade não aparecem aqui. Não são ocultados nem eliminados. Clique novamente no sino para voltar à árvore de pastas e encontrá-los no local original.

## Uma conversa, uma linha

Uma conversa pode pertencer a várias pastas. Activity junta essas referências numa linha e mantém os nomes das pastas por baixo do título. Passe o cursor sobre essa informação para ver os caminhos completos.

Assim, a mesma conversa não ocupa vários lugares em Prioridade ou Hoje e mantém o contexto dos projetos a que pertence.

## Três sinais com funções diferentes

| Sinal    | Origem                                   | Pergunta a que responde                 |
| -------- | ---------------------------------------- | --------------------------------------- |
| Pastas   | Projetos e temas organizados manualmente | Onde pertence esta conversa?            |
| Activity | Hora do último turno real                | Que trabalho avançou recentemente?      |
| Star     | Marca manual                             | Que conversas devem continuar marcadas? |

As pastas ajudam a recuperar algo do arquivo. Activity reduz as opções que precisam de ser avaliadas sempre que regressa ao Gemini. Retome uma conversa que ainda tenha continuidade em Prioridade, siga para Hoje ou Ontem e volte à árvore completa quando precisar de material mais antigo.
